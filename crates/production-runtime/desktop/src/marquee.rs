use anyhow::{bail, ensure, Context, Result};
use producer_production_contract::{Content, Set};

pub fn lines(text:&str)->Result<[String;2]> {
    let chars:Vec<_>=text.trim().chars().collect();
    if chars.len()<=22 {return Ok([chars.iter().collect(),String::new()]);}
    ensure!(chars.len()<=52,"Shorten the cue to fit two lines");
    let mid=chars.len()/2;
    let split=(1..chars.len()).filter(|&i|i<=26 && chars.len()-i<=26 && chars[i].is_whitespace())
        .min_by_key(|i|i.abs_diff(mid)).unwrap_or(mid);
    Ok([chars[..split].iter().collect::<String>().trim().into(),chars[split..].iter().collect::<String>().trim().into()])
}

pub fn apply(set:&mut Set,text:&str)->Result<()> {
    ensure!(set.theme.contains_key("marquee"),"Set has no marquee");
    let lines=lines(text)?;
    for layout in set.layouts.values_mut() {
        for (i,id) in ["marquee","marquee-second"].iter().enumerate(){
            let node=layout.root.children.iter_mut().find(|n|n.id==*id).context("Missing marquee line")?;
            let Content::Text{value,..}=&mut node.content else{bail!("Expected marquee text")};
            *value=lines[i].clone();
            let frame=node.frame.as_mut().context("Missing marquee frame")?;
            let height=layout.height as f64;
            frame.y=height*(if lines[1].is_empty(){0.365}else{0.348+i as f64*0.043});
            let style=node.style.as_mut().and_then(|s|s.text.as_mut()).context("Missing marquee text style")?;
            style.font_size=(height*if lines[1].is_empty(){0.048}else{0.036}).min(frame.width/(value.chars().count().max(1) as f64*0.82));
        }
    }
    Ok(())
}
