use crate::contract::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Command {
    Import {
        document: Document,
    },
    Restore {
        document: Document,
        #[serde(rename = "historyEntry")]
        history_entry: Counter,
    },
    Transaction {
        operations: Vec<Operation>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", deny_unknown_fields, rename_all = "camelCase")]
pub enum Operation {
    SetTitle {
        title: String,
    },
    AddAsset {
        id: Id,
        value: Asset,
    },
    RemoveAsset {
        id: Id,
    },
    AddSource {
        id: Id,
        value: Source,
    },
    RemoveSource {
        id: Id,
    },
    AddComponent {
        id: Id,
        value: Component,
    },
    ReplaceComponent {
        id: Id,
        value: Component,
    },
    RemoveComponent {
        id: Id,
    },
    AddSet {
        id: Id,
        value: Set,
    },
    ReplaceSet {
        id: Id,
        value: Set,
    },
    RemoveSet {
        id: Id,
    },
    AddSequence {
        id: Id,
        value: Sequence,
    },
    ReplaceSequence {
        id: Id,
        value: Sequence,
    },
    RemoveSequence {
        id: Id,
    },
    AddShow {
        id: Id,
        value: Show,
    },
    ReplaceShow {
        id: Id,
        value: Show,
    },
    RemoveShow {
        id: Id,
    },
    SetThemeToken {
        set: Id,
        token: Id,
        color: String,
    },
    SetControl {
        set: Id,
        control: Control,
    },
    SetText {
        set: Id,
        layout: Id,
        path: Vec<Id>,
        text: String,
    },
    SetFrame {
        set: Id,
        layout: Id,
        path: Vec<Id>,
        frame: Rect,
    },
    SetComponentProp {
        set: Id,
        layout: Id,
        path: Vec<Id>,
        prop: Id,
        value: Value,
    },
}
fn bad(p: &str, m: &str) -> Error {
    Error::new("COMMAND", p, m)
}
fn add<T>(map: &mut std::collections::BTreeMap<String, T>, id: &str, value: T) -> Result<()> {
    if map.contains_key(id) {
        return Err(bad(id, "already exists"));
    }
    map.insert(id.into(), value);
    Ok(())
}
fn replace<T>(map: &mut std::collections::BTreeMap<String, T>, id: &str, value: T) -> Result<()> {
    if !map.contains_key(id) {
        return Err(bad(id, "does not exist"));
    }
    map.insert(id.into(), value);
    Ok(())
}
fn remove<T>(map: &mut std::collections::BTreeMap<String, T>, id: &str) -> Result<()> {
    if map.remove(id).is_none() {
        return Err(bad(id, "does not exist"));
    }
    Ok(())
}
fn node<'a>(d: &'a mut Document, s: &str, l: &str, path: &[String]) -> Result<&'a mut Node> {
    let mut n = &mut d
        .sets
        .get_mut(s)
        .ok_or_else(|| bad(s, "Set missing"))?
        .layouts
        .get_mut(l)
        .ok_or_else(|| bad(l, "layout missing"))?
        .root;
    if path.first() != Some(&n.id) {
        return Err(bad("path", "root identity mismatch"));
    }
    for id in &path[1..] {
        n = n.children.iter_mut().find(|n| &n.id == id).ok_or_else(|| {
            bad(
                id,
                "node missing; component internals require an explicit definition edit",
            )
        })?;
    }
    Ok(n)
}
pub fn apply(document: &Document, command: &Command) -> Result<Document> {
    let bytes = serde_json::to_vec(command).map_err(|e| bad("$", &e.to_string()))?;
    ingress::parse_envelope(
        &bytes,
        match command {
            Command::Import { .. } | Command::Restore { .. } => DOCUMENT_BYTES + 1024,
            _ => COMMAND_BYTES,
        },
    )?;
    let mut d = document.clone();
    match command {
        Command::Import { document } | Command::Restore { document, .. } => {
            if document.id != d.id {
                return Err(bad(
                    "id",
                    "a store cannot silently become a different document",
                ));
            }
            d = document.clone();
        }
        Command::Transaction { operations } => {
            if operations.is_empty() || operations.len() > OPERATIONS {
                return Err(bad("operations", "requires 1..64 operations"));
            }
            for op in operations {
                match op {
                    Operation::SetTitle { title } => d.title = title.clone(),
                    Operation::AddAsset { id, value } => add(&mut d.assets, id, value.clone())?,
                    Operation::RemoveAsset { id } => remove(&mut d.assets, id)?,
                    Operation::AddSource { id, value } => add(&mut d.sources, id, value.clone())?,
                    Operation::RemoveSource { id } => remove(&mut d.sources, id)?,
                    Operation::AddComponent { id, value } => {
                        add(&mut d.components, id, value.clone())?
                    }
                    Operation::ReplaceComponent { id, value } => {
                        replace(&mut d.components, id, value.clone())?
                    }
                    Operation::RemoveComponent { id } => remove(&mut d.components, id)?,
                    Operation::AddSet { id, value } => add(&mut d.sets, id, value.clone())?,
                    Operation::ReplaceSet { id, value } => replace(&mut d.sets, id, value.clone())?,
                    Operation::RemoveSet { id } => remove(&mut d.sets, id)?,
                    Operation::AddSequence { id, value } => {
                        add(&mut d.sequences, id, value.clone())?
                    }
                    Operation::ReplaceSequence { id, value } => {
                        replace(&mut d.sequences, id, value.clone())?
                    }
                    Operation::RemoveSequence { id } => remove(&mut d.sequences, id)?,
                    Operation::AddShow { id, value } => add(&mut d.shows, id, value.clone())?,
                    Operation::ReplaceShow { id, value } => {
                        replace(&mut d.shows, id, value.clone())?
                    }
                    Operation::RemoveShow { id } => remove(&mut d.shows, id)?,
                    Operation::SetThemeToken { set, token, color } => {
                        d.sets
                            .get_mut(set)
                            .ok_or_else(|| bad(set, "Set missing"))?
                            .theme
                            .insert(token.clone(), color.clone());
                    }
                    Operation::SetControl { set, control } => {
                        let controls = &mut d
                            .sets
                            .get_mut(set)
                            .ok_or_else(|| bad(set, "Set missing"))?
                            .controls;
                        if let Some(old) = controls.iter_mut().find(|c| c.id == control.id) {
                            *old = control.clone();
                        } else {
                            controls.push(control.clone());
                        }
                    }
                    Operation::SetText {
                        set,
                        layout,
                        path,
                        text,
                    } => match &mut node(&mut d, set, layout, path)?.content {
                        Content::Text { value, .. } => *value = text.clone(),
                        _ => return Err(bad("path", "text node required")),
                    },
                    Operation::SetFrame {
                        set,
                        layout,
                        path,
                        frame,
                    } => node(&mut d, set, layout, path)?.frame = Some(*frame),
                    Operation::SetComponentProp {
                        set,
                        layout,
                        path,
                        prop,
                        value,
                    } => match &mut node(&mut d, set, layout, path)?.content {
                        Content::Component { props, .. } => {
                            props.insert(prop.clone(), value.clone());
                        }
                        _ => return Err(bad("path", "component instance required")),
                    },
                }
            }
        }
    }
    for (id, asset) in &document.assets {
        if d.assets.get(id).is_some_and(|new| new != asset) {
            return Err(Error::new(
                "IMMUTABLE_ASSET",
                id,
                "asset identity cannot be rebound; declare a new asset",
            ));
        }
    }
    // Hosted projections have a separate trusted ingress in a future adapter;
    // the local authoring catalog cannot mint, replace or delete their authority.
    for (id, c) in &document.components {
        if c.authority == Authority::Hosted && d.components.get(id) != Some(c) {
            return Err(Error::new(
                "HOSTED_AUTHORITY",
                id,
                "hosted component is read-only",
            ));
        }
    }
    for (id, c) in &d.components {
        if c.authority == Authority::Hosted && document.components.get(id) != Some(c) {
            return Err(Error::new(
                "HOSTED_AUTHORITY",
                id,
                "local command cannot create hosted authority",
            ));
        }
    }
    for (id, s) in &document.shows {
        if s.authority == Authority::Hosted && d.shows.get(id) != Some(s) {
            return Err(Error::new(
                "HOSTED_AUTHORITY",
                id,
                "hosted Show is read-only",
            ));
        }
    }
    for (id, s) in &d.shows {
        if s.authority == Authority::Hosted && document.shows.get(id) != Some(s) {
            return Err(Error::new(
                "HOSTED_AUTHORITY",
                id,
                "local command cannot create hosted authority",
            ));
        }
    }
    validate_document(&d)?;
    crate::compile::compile(&d)?;
    Ok(d)
}
pub fn schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Command)).unwrap()
}
