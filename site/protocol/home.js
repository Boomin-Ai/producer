const byId = id => document.getElementById(id);
const clock = seconds => [Math.floor(seconds / 60), String(Math.floor(seconds % 60)).padStart(2, "0")].join(":");
const names = {camera:"Shaan", "camera-2":"Sam", "rtc-guest":"Guest", screen:"Screen share", landscape:"Two hosts", composite:"Composite"};
const label = key => names[key] || key.replace(/-landscape$/, "").replaceAll("-", " ").replace(/^./, c => c.toUpperCase()).replace(/shaan|sam/g, word => word[0].toUpperCase() + word.slice(1));

async function json(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(path);
  return response.json();
}

async function showRelease() {
  const version = (await json("/download/meta.json")).platforms?.macos?.version;
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    document.querySelectorAll("[data-mac-version]").forEach(el => el.textContent = "v" + version);
  }
}

async function showStars() {
  const {count} = await json("/api/stars");
  if (Number.isSafeInteger(count) && count >= 0) {
    document.querySelectorAll("[data-stars]").forEach(el => {
      el.textContent = count.toLocaleString();
      el.closest("a").setAttribute("aria-label", "Producer on GitHub, " + count + " stars");
    });
  }
}

function button(title, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = title;
  element.addEventListener("click", action);
  return element;
}

async function showProduction() {
  const {segments} = await json("/protocol/example.json");
  const rundown = byId("segments"), cues = byId("cues"), slider = byId("segment-time");
  let segment, previous;
  function seek(time) {
    slider.value = time;
    const change = segment.changes.findLast(change => change.at <= time);
    const readout = clock(time) + " / " + clock(segment.duration);
    byId("time-readout").textContent = readout;
    slider.setAttribute("aria-valuetext", readout);
    if (change === previous) return;
    previous = change;
    const layout = label(change.landscape);
    byId("active-layout").textContent = layout;
    for (const orientation of ["landscape", "portrait"]) {
      const image = byId(orientation + "-output");
      image.src = "/protocol/" + change[orientation] + ".jpg";
      image.alt = layout + ", " + orientation + " output";
    }
    const stages = [change.sources.map(label).join(" + "), ...change.passes.map(label), "Landscape + portrait"];
    const graph = byId("graph-path");
    graph.replaceChildren();
    stages.forEach((stage, index) => {
      if (index) graph.append(" → ");
      const node = document.createElement("span");
      node.textContent = stage;
      graph.append(node);
    });
    Array.from(cues.children).forEach((item, index) => item.setAttribute("aria-pressed", segment.changes[index] === change));
  }

  function select(index) {
    segment = segments[index];
    previous = null;
    slider.max = segment.duration;
    Array.from(rundown.children).forEach((item, i) => item.setAttribute("aria-pressed", index === i));
    cues.replaceChildren(...segment.changes.map(change =>
      button(clock(change.at) + " " + label(change.landscape), () => seek(change.at))));
    seek(0);
  }
  rundown.replaceChildren(...segments.map((entry, i) => button(entry.title, () => select(i))));
  slider.addEventListener("input", () => seek(Number(slider.value)));
  select(0);
  slider.disabled = false;
}

Promise.allSettled([showStars(), showRelease(), showProduction().catch(() => {
  byId("segments").textContent = "Preview unavailable. Open the production document to explore the rundown.";
})]);
