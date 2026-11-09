//! Pure engine ownership decisions. OBS creation/teardown stays on the engine
//! thread, while these receipt and retention rules are testable without media.
use std::collections::HashMap;

pub const MAX_APPEARANCES: usize = 4;

pub fn can_acquire(
    bound_room: Option<&str>,
    requested_room: &str,
    duplicate: bool,
    active_count: usize,
) -> Result<(), &'static str> {
    if requested_room.is_empty() || bound_room != Some(requested_room) {
        return Err("The appearance must use the room already running on this device");
    }
    if duplicate || active_count >= MAX_APPEARANCES {
        return Err("Appearance capture is already owned");
    }
    Ok(())
}

/// Failed duplicate requests and delayed release messages own different
/// receipts. They cannot remove a current owner's entry, even when IDs match.
pub fn take_matching<T>(
    leases: &mut HashMap<String, (T, bool, String)>,
    appearance_id: &str,
    lease_id: &str,
) -> Option<(T, bool, String)> {
    if leases
        .get(appearance_id)
        .is_some_and(|(_, _, current)| current == lease_id)
    {
        leases.remove(appearance_id)
    } else {
        None
    }
}

pub fn retain_room(
    streaming: bool,
    recording: bool,
    portrait_recording: bool,
    appearance_count: usize,
) -> bool {
    streaming || recording || portrait_recording || appearance_count != 0
}

pub fn retain_portrait(recording: bool, selected: bool, appearance_portrait: bool) -> bool {
    recording || selected || appearance_portrait
}

pub fn shutdown_ready(appearance_count: usize) -> bool {
    appearance_count == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_room_identity_and_capacity_are_required_before_capture() {
        assert!(can_acquire(None, "local-a", false, 0).is_err());
        assert!(can_acquire(Some("local-a"), "local-b", false, 0).is_err());
        assert!(can_acquire(Some(""), "", false, 0).is_err());
        assert!(can_acquire(Some("local-a"), "local-a", false, MAX_APPEARANCES - 1).is_ok());
        assert!(can_acquire(Some("local-a"), "local-a", false, MAX_APPEARANCES).is_err());
    }

    #[test]
    fn failed_duplicate_and_old_release_cannot_remove_current_capture() {
        let mut leases =
            HashMap::from([("appearance-a".to_owned(), (7, true, "receipt-1".to_owned()))]);
        assert!(can_acquire(
            Some("local"),
            "local",
            leases.contains_key("appearance-a"),
            leases.len()
        )
        .is_err());
        // Dropping the rejected request's keeper emits its own receipt.
        assert!(take_matching(&mut leases, "appearance-a", "rejected-receipt").is_none());
        assert_eq!(leases["appearance-a"].0, 7);
        assert_eq!(
            take_matching(&mut leases, "appearance-a", "receipt-1")
                .unwrap()
                .0,
            7
        );
        leases.insert(
            "appearance-a".to_owned(),
            (8, false, "receipt-2".to_owned()),
        );
        assert!(take_matching(&mut leases, "appearance-a", "receipt-1").is_none());
        assert_eq!(leases["appearance-a"].0, 8);
        assert!(take_matching(&mut leases, "unrelated-id", "receipt-2").is_none());
    }

    #[test]
    fn each_output_retains_the_room_and_one_owner_release_keeps_others() {
        for output in 0..4 {
            assert!(retain_room(
                output == 0,
                output == 1,
                output == 2,
                usize::from(output == 3)
            ));
        }
        assert!(!retain_room(false, false, false, 0));
        let mut leases = HashMap::from([
            ("a".into(), (1, false, "one".into())),
            ("b".into(), (2, true, "two".into())),
        ]);
        take_matching(&mut leases, "a", "one").unwrap();
        assert!(retain_room(false, false, false, leases.len()));
        assert!(!shutdown_ready(leases.len()));
        assert!(retain_portrait(
            false,
            false,
            leases.values().any(|(_, portrait, _)| *portrait)
        ));
        take_matching(&mut leases, "b", "two").unwrap();
        assert!(shutdown_ready(leases.len()));
        assert!(
            retain_room(true, true, false, leases.len()),
            "ending the last appearance cannot release a live stream/recording"
        );
    }

    #[test]
    fn landscape_only_appearance_does_not_retain_unused_portrait_canvas() {
        assert!(!retain_portrait(false, false, false));
        assert!(retain_portrait(true, false, false));
        assert!(retain_portrait(false, true, false));
        assert!(retain_portrait(false, false, true));
    }
}
