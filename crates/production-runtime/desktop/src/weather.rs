//! Room-owned weather snapshots. Only the worker contacts the provider.
//! Controls project a cached observation into text fields for either output.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub type Fields = BTreeMap<String, String>;
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum View {
    #[default]
    Now,
    Today,
    Hourly,
    Week,
    Compare,
}
impl View {
    pub const CHOICES: [(Self, &'static str); 5] = [
        (Self::Now, "Now"),
        (Self::Today, "Today"),
        (Self::Hourly, "Hourly"),
        (Self::Week, "7 day"),
        (Self::Compare, "Compare"),
    ];
}
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub city: String,
    latitude: f64,
    longitude: f64,
    timezone: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitySlot {
    Primary,
    Comparison,
}

impl CitySlot {
    fn config(self) -> &'static str {
        match self {
            Self::Primary => "weather.json",
            Self::Comparison => "weather-comparison.json",
        }
    }
    fn cache(self) -> &'static str {
        match self {
            Self::Primary => "weather-cache.json",
            Self::Comparison => "weather-comparison-cache.json",
        }
    }
    pub fn location(self, root: &Path) -> Option<Connection> {
        read(&root.join(self.config())).ok()
    }
}

#[derive(Debug, Deserialize)]
pub struct Place {
    name: String,
    latitude: f64,
    longitude: f64,
    timezone: Option<String>,
    admin1: Option<String>,
    country_code: Option<String>,
}
impl Place {
    pub fn label(&self) -> String {
        [
            Some(self.name.as_str()),
            self.admin1.as_deref(),
            self.country_code.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ")
    }
    pub fn connection(&self) -> Connection {
        Connection {
            city: self.name.clone(),
            latitude: self.latitude,
            longitude: self.longitude,
            timezone: self.timezone.clone().unwrap_or_else(|| "auto".into()),
        }
    }
}
pub fn search(query: &str) -> Result<Vec<Place>> {
    let query = query.trim();
    ensure!(
        query.chars().count() >= 2 && query.len() <= 160,
        "Enter a city name of at least two characters"
    );
    let result = Command::new("/usr/bin/curl")
        .args([
            "-q",
            "-fsS",
            "--max-time",
            "8",
            "--max-filesize",
            "131072",
            "--get",
            "https://geocoding-api.open-meteo.com/v1/search",
            "--data-urlencode",
            &format!("name={query}"),
            "-d",
            "count=5",
            "-d",
            "language=en",
        ])
        .output()?;
    ensure!(result.status.success(), "City search is unavailable");
    #[derive(Deserialize)]
    struct Matches {
        #[serde(default)]
        results: Vec<Place>,
    }
    Ok(serde_json::from_slice::<Matches>(&result.stdout)?.results)
}
pub fn set_city(root: &Path, slot: CitySlot, city: &Connection) -> Result<()> {
    ensure!(
        root.join("weather.json").is_file(),
        "Room has no forecast connection"
    );
    ensure!(
        (-90.0..=90.).contains(&city.latitude)
            && (-180.0..=180.).contains(&city.longitude)
            && !city.city.trim().is_empty()
            && city.city.len() <= 128
            && city.timezone.len() <= 96,
        "Invalid weather location"
    );
    write(&root.join(slot.config()), city)
}
#[derive(Deserialize, Serialize)]
struct Current {
    time: String,
    temperature_2m: f64,
    relative_humidity_2m: f64,
    wind_speed_10m: f64,
    weather_code: u16,
    #[serde(default)]
    apparent_temperature: Option<f64>,
    #[serde(default)]
    surface_pressure: Option<f64>,
}
#[derive(Deserialize, Serialize)]
struct Hourly {
    time: Vec<String>,
    temperature_2m: Vec<Option<f64>>,
}
#[derive(Deserialize, Serialize)]
struct Daily {
    time: Vec<String>,
    temperature_2m_max: Vec<Option<f64>>,
    temperature_2m_min: Vec<Option<f64>>,
    #[serde(default)]
    sunrise: Vec<String>,
    #[serde(default)]
    sunset: Vec<String>,
}
#[derive(Deserialize, Serialize)]
struct Forecast {
    current: Current,
    hourly: Hourly,
    daily: Daily,
}
#[derive(Deserialize, Serialize)]
struct Snapshot {
    connection: Connection,
    fetched: u64,
    forecast: Forecast,
}
fn clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn read<T: serde::de::DeserializeOwned>(p: &Path) -> Result<T> {
    use std::io::Read;
    let mut bytes = vec![];
    fs::File::open(p)?.take(262145).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 262144, "Weather object exceeds cache limit");
    Ok(serde_json::from_slice(&bytes)?)
}
fn write<T: Serialize>(p: &Path, v: &T) -> Result<()> {
    let tmp = p.with_extension("pending");
    fs::write(&tmp, serde_json::to_vec(v)?)?;
    Ok(fs::rename(tmp, p)?)
}
pub fn selected_view(root: &Path) -> Result<View> {
    let path = root.join("forecast-view.json");
    if path.exists() {
        read(&path)
    } else {
        Ok(View::default())
    }
}
pub fn select(root: &Path, view: View) -> Result<()> {
    ensure!(
        root.join("weather.json").is_file(),
        "Room has no forecast connection"
    );
    write(&root.join("forecast-view.json"), &view)
}
fn condition(code: u16) -> &'static str {
    match code {
        0 => "Clear skies",
        1 => "Mostly clear",
        2 => "Partly cloudy",
        3 => "Overcast",
        45 | 48 => "Fog",
        51..=57 => "Drizzle",
        61..=67 | 80..=82 => "Rain",
        71..=77 | 85 | 86 => "Snow",
        95..=99 => "Thunderstorms",
        _ => "Variable skies",
    }
}
fn deg(t: Option<f64>) -> String {
    t.map_or_else(|| "—".into(), |v| format!("{v:.0}°"))
}
impl Forecast {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.hourly.time.len() == self.hourly.temperature_2m.len()
                && self.hourly.time.len() <= 192,
            "Invalid hourly series"
        );
        ensure!(
            self.daily.time.len() == self.daily.temperature_2m_max.len()
                && self.daily.time.len() == self.daily.temperature_2m_min.len()
                && (1..=7).contains(&self.daily.time.len()),
            "Invalid daily series"
        );
        ensure!(
            self.current.temperature_2m.is_finite()
                && (0.0..=100.).contains(&self.current.relative_humidity_2m)
                && self.current.wind_speed_10m >= 0.,
            "Invalid current observation"
        );
        Ok(())
    }
    fn fields(&self, c: &Connection, view: View, status: &str) -> Fields {
        let cur = &self.current;
        let mut f = Fields::from([
            ("city".into(), c.city.clone()),
            ("temperature-c".into(), cur.temperature_2m.to_string()),
            ("longitude".into(), c.longitude.to_string()),
            ("latitude".into(), c.latitude.to_string()),
            ("wind-kmh".into(), cur.wind_speed_10m.to_string()),
            ("temperature".into(), deg(Some(cur.temperature_2m))),
            ("condition".into(), condition(cur.weather_code).into()),
            ("status".into(), status.into()),
            ("feels".into(), deg(cur.apparent_temperature)),
            (
                "pressure".into(),
                cur.surface_pressure
                    .map_or_else(|| "—".into(), |v| format!("{v:.0} hPa")),
            ),
            (
                "sunrise".into(),
                self.daily
                    .sunrise
                    .first()
                    .and_then(|v| v.get(11..16))
                    .unwrap_or("—")
                    .into(),
            ),
            (
                "sunset".into(),
                self.daily
                    .sunset
                    .first()
                    .and_then(|v| v.get(11..16))
                    .unwrap_or("—")
                    .into(),
            ),
            ("high".into(), deg(self.daily.temperature_2m_max[0])),
            ("low".into(), deg(self.daily.temperature_2m_min[0])),
            ("wind".into(), format!("{:.0} km/h", cur.wind_speed_10m)),
            (
                "humidity".into(),
                format!("{:.0}%", cur.relative_humidity_2m),
            ),
            (
                "observed".into(),
                format!("{}  ·  °C", cur.time.replace('T', "  ")),
            ),
        ]);
        let day = &self.daily;
        let mut rows = vec![];
        let title = match view {
            View::Now | View::Compare => {
                rows.extend([
                    ("High".into(), deg(day.temperature_2m_max[0])),
                    ("Low".into(), deg(day.temperature_2m_min[0])),
                    ("Wind".into(), f["wind"].clone()),
                ]);
                "Conditions"
            }
            View::Today => {
                rows.extend([
                    ("Maximum".into(), deg(day.temperature_2m_max[0])),
                    ("Minimum".into(), deg(day.temperature_2m_min[0])),
                    ("Humidity".into(), f["humidity"].clone()),
                ]);
                "Today"
            }
            View::Hourly => {
                for (time, t) in self
                    .hourly
                    .time
                    .iter()
                    .zip(&self.hourly.temperature_2m)
                    .filter(|(s, _)| s.get(..13) >= cur.time.get(..13))
                    .take(7)
                {
                    rows.push((time.get(11..16).unwrap_or("—").into(), deg(*t)));
                }
                "Next hours"
            }
            View::Week => {
                for (i, date) in day.time.iter().enumerate() {
                    rows.push((
                        date.get(5..).unwrap_or("—").into(),
                        format!(
                            "{} / {}",
                            deg(day.temperature_2m_max[i]),
                            deg(day.temperature_2m_min[i])
                        ),
                    ));
                }
                "Seven days"
            }
        };
        f.insert("panel".into(), title.into());
        for i in 0..7 {
            let (label, value) = rows.get(i).cloned().unwrap_or_default();
            f.insert(format!("label-{i}"), label);
            f.insert(format!("value-{i}"), value);
        }
        f
    }
}
fn city_fields(root: &Path, slot: CitySlot, connection: &Connection, view: View) -> Result<Fields> {
    if let Ok(s) = read::<Snapshot>(&root.join(slot.cache())) {
        let age = clock().checked_sub(s.fetched);
        if &s.connection == connection && age.is_some_and(|s| s <= 2100) {
            s.forecast.validate()?;
            return Ok(s.forecast.fields(
                connection,
                view,
                if age.unwrap() < 300 {
                    "LIVE FORECAST"
                } else {
                    "STALE FORECAST"
                },
            ));
        }
    }
    if let Ok(s) = read::<Snapshot>(&root.join(match slot {
        CitySlot::Primary => "weather-rehearsal.json",
        CitySlot::Comparison => "weather-comparison-rehearsal.json",
    })) {
        if &s.connection == connection {
            s.forecast.validate()?;
            return Ok(s.forecast.fields(connection, view, "REHEARSAL FORECAST"));
        }
    }
    let mut f = Fields::new();
    f.insert("city".into(), connection.city.clone());
    f.insert("status".into(), "AWAITING FORECAST".into());
    Ok(f)
}
pub fn fields(root: &Path) -> Result<Fields> {
    let Some(primary) = CitySlot::Primary.location(root) else {
        return Ok(Fields::new());
    };
    let view = selected_view(root)?;
    let mut f = city_fields(root, CitySlot::Primary, &primary, view)?;
    let mut cols: [Vec<(String, String)>; 2] = Default::default();
    let val = |fields: &Fields, key: &str| fields.get(key).cloned().unwrap_or_else(|| "—".into());
    let column_titles = match view {
        View::Compare => {
            let mut other = Fields::new();
            if let Some(city) = CitySlot::Comparison.location(root) {
                other = city_fields(root, CitySlot::Comparison, &city, View::Now)?;
            }
            for (col, fields) in cols.iter_mut().zip([&f, &other]) {
                for (label, key) in [
                    ("Temperature", "temperature"),
                    ("High", "high"),
                    ("Low", "low"),
                    ("Wind", "wind"),
                ] {
                    col.push((label.into(), val(fields, key)));
                }
            }
            f.insert("panel".into(), "City comparison".into());
            f.insert(
                "right-status".into(),
                other
                    .get("status")
                    .cloned()
                    .unwrap_or_else(|| "CHOOSE A CITY".into()),
            );
            f.insert("left-status".into(), val(&f, "status"));
            [
                primary.city.clone(),
                other.remove("city").unwrap_or_else(|| "Second city".into()),
            ]
        }
        View::Week | View::Hourly => {
            for i in 0..7 {
                cols[i / 4].push((
                    val(&f, &format!("label-{i}")),
                    val(&f, &format!("value-{i}")),
                ));
            }
            if view == View::Week {
                ["Days 1–4".into(), "Days 5–7".into()]
            } else {
                ["Next four hours".into(), "Following hours".into()]
            }
        }
        View::Now | View::Today => {
            for (idx, label, key) in [
                (0, "Feels like", "feels"),
                (0, "Wind", "wind"),
                (0, "Humidity", "humidity"),
                (0, "Pressure", "pressure"),
                (1, "High", "high"),
                (1, "Low", "low"),
                (1, "Sunrise", "sunrise"),
                (1, "Sunset", "sunset"),
            ] {
                cols[idx].push((label.into(), val(&f, key)));
            }
            if view == View::Today {
                cols.swap(0, 1);
                ["Daily range".into(), "At the surface".into()]
            } else {
                ["At the surface".into(), "Daily range".into()]
            }
        }
    };
    for (idx, (side, title)) in ["left", "right"].into_iter().zip(column_titles).enumerate() {
        f.insert(format!("{side}-title"), title);
        for row in 0..4 {
            let (label, value) = cols[idx].get(row).cloned().unwrap_or_default();
            f.insert(format!("{side}-label-{row}"), label);
            f.insert(format!("{side}-value-{row}"), value);
        }
    }
    Ok(f)
}
fn refresh_city(root: &Path, slot: CitySlot) -> Result<()> {
    let path = root.join(slot.config());
    let c: Connection = read(&path)?;
    ensure!(
        (-90.0..=90.).contains(&c.latitude)
            && (-180.0..=180.).contains(&c.longitude)
            && c.city.len() <= 128,
        "Invalid forecast location"
    );
    let cache = root.join(slot.cache());
    if let Ok(s) = read::<Snapshot>(&cache) {
        if s.connection == c
            && clock().checked_sub(s.fetched).is_some_and(|v| v < 300)
            && s.forecast.validate().is_ok()
        {
            return Ok(());
        }
    }
    let response=Command::new("/usr/bin/curl").args(["-q","--silent","--show-error","--fail","--max-time","8","--max-filesize","262144","--get","https://api.open-meteo.com/v1/forecast","--data-urlencode",&format!("latitude={}",c.latitude),"--data-urlencode",&format!("longitude={}",c.longitude),"--data-urlencode",&format!("timezone={}",c.timezone),"-d","current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature,surface_pressure","-d","hourly=temperature_2m","-d","daily=temperature_2m_max,temperature_2m_min,sunrise,sunset","-d","forecast_days=7"]).output()?;
    ensure!(response.status.success(), "Weather provider unavailable");
    let forecast: Forecast = serde_json::from_slice(&response.stdout)?;
    forecast.validate()?;
    ensure!(read::<Connection>(&path)? == c, "Weather location changed");
    write(
        &cache,
        &Snapshot {
            connection: c,
            fetched: clock(),
            forecast,
        },
    )
}
pub fn refresh(root: &Path) -> Result<()> {
    let primary = refresh_city(root, CitySlot::Primary);
    if CitySlot::Comparison.location(root).is_some() {
        refresh_city(root, CitySlot::Comparison)?;
    }
    primary
}
pub fn start(root: std::path::PathBuf, closed: Arc<AtomicBool>) -> Result<()> {
    std::thread::Builder::new()
        .name("room-weather".into())
        .spawn(move || {
            let mut last: [Option<Connection>; 2] = [None, None];
            let mut due = [std::time::Instant::now(); 2];
            while !closed.load(Ordering::Acquire) {
                for (i, slot) in [CitySlot::Primary, CitySlot::Comparison]
                    .into_iter()
                    .enumerate()
                {
                    let current = slot.location(&root);
                    if current.is_some()
                        && (current != last[i] || std::time::Instant::now() >= due[i])
                    {
                        if let Err(error) = refresh_city(&root, slot) {
                            eprintln!("Forecast: {error}");
                        }
                        due[i] = std::time::Instant::now() + Duration::from_secs(60);
                    }
                    last[i] = current;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        })
        .context("start room weather adapter")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_snapshot_supports_four_views_and_rejects_the_previous_city() {
        let root =
            std::env::temp_dir().join(format!("atmosphere-weather-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let mut c = Connection {
            city: "Denver".into(),
            latitude: 39.74,
            longitude: -104.99,
            timezone: "America/Denver".into(),
        };
        write(&root.join("weather.json"), &c).unwrap();
        let forecast = Forecast {
            current: Current {
                time: "2026-11-21T12:00".into(),
                temperature_2m: 4.,
                relative_humidity_2m: 48.,
                wind_speed_10m: 7.,
                weather_code: 3,
                apparent_temperature: None,
                surface_pressure: None,
            },
            hourly: Hourly {
                time: vec!["2026-11-21T12:00".into()],
                temperature_2m: vec![Some(4.)],
            },
            daily: Daily {
                time: vec!["2026-11-21".into()],
                temperature_2m_max: vec![Some(8.)],
                temperature_2m_min: vec![Some(2.)],
                sunrise: vec![],
                sunset: vec![],
            },
        };
        let p = root.join("weather-cache.json");
        let mut s = Snapshot {
            connection: c.clone(),
            fetched: clock(),
            forecast,
        };
        write(&p, &s).unwrap();
        let initial = fs::read(&p).unwrap();
        for (view, _) in View::CHOICES {
            select(&root, view).unwrap();
            refresh(&root).unwrap();
            let out = fields(&root).unwrap();
            assert_eq!(out["temperature"], "4°");
            assert_eq!(out["status"], "LIVE FORECAST");
            assert_eq!(fs::read(&p).unwrap(), initial);
        }
        let second = Connection {
            city: "San Martín de los Andes".into(),
            latitude: -40.16,
            longitude: -71.35,
            timezone: "America/Argentina/Salta".into(),
        };
        set_city(&root, CitySlot::Comparison, &second).unwrap();
        let secondary_path = root.join(CitySlot::Comparison.cache());
        let mut secondary: Snapshot = read(&p).unwrap();
        secondary.forecast.current.temperature_2m = 17.;
        secondary.connection = second.clone();
        secondary.fetched -= 600;
        write(&secondary_path, &secondary).unwrap();
        select(&root, View::Compare).unwrap();
        let comparison = fields(&root).unwrap();
        assert_eq!(comparison["left-title"], "Denver");
        assert_eq!(comparison["right-title"], second.city);
        assert_eq!(comparison["left-value-0"], "4°");
        assert_eq!(comparison["right-value-0"], "17°");
        assert_eq!(comparison["right-status"], "STALE FORECAST");
        secondary.fetched -= 2101;
        write(&secondary_path, &secondary).unwrap();
        assert_eq!(fields(&root).unwrap()["right-value-0"], "—");
        assert_eq!(fields(&root).unwrap()["left-value-0"], "4°");
        s.fetched -= 600;
        write(&p, &s).unwrap();
        assert_eq!(fields(&root).unwrap()["status"], "STALE FORECAST");
        s.fetched -= 2101;
        write(&p, &s).unwrap();
        assert_eq!(fields(&root).unwrap()["status"], "AWAITING FORECAST");
        s.fetched = clock();
        write(&p, &s).unwrap();
        c.city = "Boulder".into();
        c.latitude = 40.01;
        write(&root.join("weather.json"), &c).unwrap();
        assert!(!fields(&root).unwrap().contains_key("temperature"));
        fs::remove_dir_all(root).unwrap();
    }
}
