from pathlib import Path
from xml.etree import ElementTree

from src.api import app


def test_sendplug_api_branding():
    assert app.title == "SendPlug API"
    assert "plug-and-play email delivery" in app.description.lower()


def test_production_schema_routes_are_disabled():
    assert app.docs_url is None
    assert app.redoc_url is None
    assert app.openapi_url is None


def test_legacy_endpoint_aliases_are_hidden_from_internal_schema():
    aliases = {"/send-email", "/emails/{message_id}"}
    routes = {route.path: route for route in app.routes}
    assert all(routes[path].include_in_schema is False for path in aliases)


def test_public_guide_documents_only_customer_endpoints():
    guide = Path("web/public/docs/index.html").read_text().lower()
    for public_path in ("/api/v1/send", "/api/v1/emails/"):
        assert public_path in guide
    for private_path in ("/api/v1/senders", "/api/v1/tokens", "/api/v1/campaigns", "/auth/login"):
        assert private_path not in guide


def test_small_icons_have_opaque_square_backgrounds():
    for filename in ("sendplug-app-icon.svg", "sendplug-favicon.svg"):
        root = ElementTree.parse(Path("brand/final") / filename).getroot()
        background = root.find("{http://www.w3.org/2000/svg}rect")
        assert background is not None
        assert background.attrib["fill"] == "#090909"
        assert "rx" not in background.attrib
