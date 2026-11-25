//! Wire-transparent ordered root maps. Cloned document versions share immutable
//! storage; mutating one map first detaches it, preserving every prior snapshot.
use serde::{Deserialize, Serialize};
use std::{
    collections::{btree_map, BTreeMap},
    ops::{Deref, DerefMut},
    sync::Arc,
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(transparent)]
pub struct SharedMap<T>(Arc<BTreeMap<String, T>>);
impl<T> Default for SharedMap<T> {
    fn default() -> Self {
        Self(Arc::new(BTreeMap::new()))
    }
}
impl<T> Deref for SharedMap<T> {
    type Target = BTreeMap<String, T>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl<T: Clone> DerefMut for SharedMap<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}
impl<T> From<BTreeMap<String, T>> for SharedMap<T> {
    fn from(value: BTreeMap<String, T>) -> Self {
        Self(Arc::new(value))
    }
}
impl<T> FromIterator<(String, T)> for SharedMap<T> {
    fn from_iter<I: IntoIterator<Item = (String, T)>>(iter: I) -> Self {
        BTreeMap::from_iter(iter).into()
    }
}
impl<'a, T> IntoIterator for &'a SharedMap<T> {
    type Item = (&'a String, &'a T);
    type IntoIter = btree_map::Iter<'a, String, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}
impl<'a, T: Clone> IntoIterator for &'a mut SharedMap<T> {
    type Item = (&'a String, &'a mut T);
    type IntoIter = btree_map::IterMut<'a, String, T>;
    fn into_iter(self) -> Self::IntoIter {
        self.deref_mut().iter_mut()
    }
}
impl<T: Clone> IntoIterator for SharedMap<T> {
    type Item = (String, T);
    type IntoIter = btree_map::IntoIter<String, T>;
    fn into_iter(self) -> Self::IntoIter {
        Arc::unwrap_or_clone(self.0).into_iter()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clones_share_storage_until_mutated_and_wire_remains_a_plain_object() {
        let a = SharedMap::from(BTreeMap::from([("first".into(), 1)]));
        let mut b = a.clone();
        assert!(Arc::ptr_eq(&a.0, &b.0));
        b.insert("first".into(), 2);
        b.insert("second".into(), 3);
        assert!(!Arc::ptr_eq(&a.0, &b.0));
        assert_eq!(a["first"], 1);
        assert!(!a.contains_key("second"));
        assert_eq!(serde_json::to_string(&a).unwrap(), r#"{"first":1}"#);
        let decoded: SharedMap<i32> = serde_json::from_str(r#"{"first":1}"#).unwrap();
        assert_eq!(a, decoded);
        for (_, v) in &mut b {
            *v += 1;
        }
        assert_eq!(a["first"], 1);
        assert_eq!(b["first"], 3);
        let mut c = a.clone();
        c.remove("first");
        assert_eq!(a.len(), 1);
        assert_eq!(
            a.clone().into_iter().collect::<Vec<_>>(),
            vec![("first".into(), 1)]
        );
    }
}
