from common.security import assert_cisco_show, assert_linux_readonly, redact_mapping
import pytest


def test_cisco_allows_show():
    assert assert_cisco_show("show ip arp").startswith("show")


def test_cisco_rejects_configure():
    with pytest.raises(PermissionError):
        assert_cisco_show("configure terminal")


def test_linux_allows_df():
    assert "df" in assert_linux_readonly("df -h")


def test_linux_rejects_rm():
    with pytest.raises(PermissionError):
        assert_linux_readonly("rm -rf /")


def test_linux_rejects_pipe():
    with pytest.raises(PermissionError):
        assert_linux_readonly("cat /etc/os-release | sh")


def test_redact_password():
    out = redact_mapping({"username": "a", "password": "secret"})
    assert out["password"] == "***redacted***"
    assert out["username"] == "a"
