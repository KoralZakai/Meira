"""A model artefact must never masquerade as something the user told us.

The live store held `"name": "save_profile"` for a real user: the model emitted
the TOOL's name as the `name` argument, update_profile merged any non-None
value blindly, and missing_fields() then saw a filled name — so Lumi stopped
asking and greeted her as "save_profile" indefinitely. An empty field would
have been strictly better, because empty is self-correcting.

These tests pin both halves: reject on write, and treat an already-poisoned
value as missing on read, so profiles corrupted before the fix heal themselves
the next time the user says their name.
"""
import json

import pytest

import user_profile


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    """Point the module at a throwaway store — never the real /data one."""
    path = tmp_path / "profiles.json"
    monkeypatch.setattr(user_profile, "_PATH", str(path))
    return path


def test_tool_name_is_not_saved_as_a_name():
    user_profile.update_profile("972500000001", name="save_profile")
    assert user_profile.get_profile("972500000001")["name"] == "there"


def test_tool_name_does_not_overwrite_a_real_name():
    user_profile.update_profile("972500000002", name="Koral")
    user_profile.update_profile("972500000002", name="save_profile")
    assert user_profile.get_profile("972500000002")["name"] == "Koral"


@pytest.mark.parametrize("junk", ["null", "None", "N/A", "unknown", "  UNDEFINED  ", "string"])
def test_placeholder_values_are_refused(junk):
    user_profile.update_profile("972500000003", homeAddress="Herzl 1, Tel Aviv")
    user_profile.update_profile("972500000003", homeAddress=junk)
    assert user_profile.get_profile("972500000003")["homeAddress"] == "Herzl 1, Tel Aviv"


def test_a_field_echoing_its_own_name_is_refused():
    user_profile.update_profile("972500000004", name="name")
    assert user_profile.get_profile("972500000004")["name"] == "there"


def test_real_values_still_save():
    """The guard must not be so eager that it eats legitimate answers."""
    prof = user_profile.update_profile(
        "972500000005",
        name="Koral",
        homeAddress="Mordei ha-Geta'ot St 25, Tel Aviv-Yafo",
        transportType="bus",
        morningRoutineMinutes=40,
    )
    assert prof["name"] == "Koral"
    assert prof["homeAddress"].startswith("Mordei")
    assert prof["transportType"] == "bus"
    assert prof["morningRoutineMinutes"] == 40


def test_non_string_values_are_untouched():
    """_is_junk only inspects strings; booleans and ints must pass through."""
    prof = user_profile.update_profile("972500000006", onboarded=True, wakeBufferMinutes=0)
    assert prof["onboarded"] is True
    assert prof["wakeBufferMinutes"] == 0


def test_an_already_poisoned_profile_reads_as_missing(store):
    """The repair path for data written before this fix — no shell access needed."""
    store.write_text(json.dumps({
        "972500000000": {"name": "save_profile", "homeAddress": "", "transportType": "car"},
    }), encoding="utf-8")

    missing = user_profile.missing_fields("972500000000")
    assert "your name" in missing, "Lumi must ask for the name again"
    assert "your home address" in missing

    # And saying it once is enough to fix the stored record.
    user_profile.update_profile("972500000000", name="Koral")
    assert user_profile.get_profile("972500000000")["name"] == "Koral"
    assert "your name" not in user_profile.missing_fields("972500000000")
