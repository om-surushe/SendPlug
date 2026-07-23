from pathlib import Path
from xml.etree import ElementTree

from src.api import app


def test_sendplug_api_branding():
    assert app.title == "SendPlug API"
    assert "plug-and-play email delivery" in app.description.lower()


def test_small_icons_have_opaque_square_backgrounds():
    for filename in ("sendplug-app-icon.svg", "sendplug-favicon.svg"):
        root = ElementTree.parse(Path("brand/final") / filename).getroot()
        background = root.find("{http://www.w3.org/2000/svg}rect")
        assert background is not None
        assert background.attrib["fill"] == "#090909"
        assert "rx" not in background.attrib
