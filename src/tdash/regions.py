"""Country -> the chatbot's regional knowledge base. A copy of the chatbot's own table
(turnstile/util/region.py): a persona's expected region is what the chatbot would resolve
for it, so every cited document can be checked against it. Keep the two in step.
"""

_EMEA = frozenset(
    {
        "AE",
        "AT",
        "AZ",
        "BA",
        "BE",
        "BG",
        "BH",
        "CH",
        "CI",
        "CM",
        "CY",
        "CZ",
        "DE",
        "DK",
        "DZ",
        "EE",
        "EG",
        "ES",
        "ET",
        "FI",
        "FR",
        "GB",
        "GE",
        "GH",
        "GR",
        "HR",
        "HU",
        "IE",
        "IL",
        "IQ",
        "IS",
        "IT",
        "JO",
        "KE",
        "KG",
        "KW",
        "KZ",
        "LB",
        "LT",
        "LV",
        "MA",
        "MD",
        "MK",
        "MU",
        "NG",
        "NL",
        "NO",
        "OM",
        "PK",
        "PL",
        "PT",
        "QA",
        "RO",
        "RS",
        "SA",
        "SE",
        "SI",
        "SK",
        "SN",
        "TM",
        "TN",
        "TR",
        "UA",
        "UZ",
        "ZA",
    }
)
_LATAM = frozenset(["BR"])
_ALIASES = {"CANADA": "CA", "UNITED STATES": "US", "BRAZIL": "BR"}
_LITERAL = {"EMEA": "hremea", "LATAM": "hrlatam"}


def region_for_country(country: str | None) -> str | None:
    """ISO-2 code (or a roster literal) -> regional HR account, else None (no knowledge base)."""
    c = (country or "").strip().upper()
    if not c:
        return None
    if c in _LITERAL:
        return _LITERAL[c]
    c = _ALIASES.get(c, c)
    if c == "US":
        return "hrus"
    if c == "CA":
        return "hrcanada"
    if c in _LATAM:
        return "hrlatam"
    if c in _EMEA:
        return "hremea"
    return None


def region_for_persona(persona: dict) -> str | None:
    """None for a persona deliberately kept out of the roster: the chatbot finds no row, so no KB."""
    if str(persona.get("in_roster", "Y")).strip().upper() == "N":
        return None
    return region_for_country(persona.get("COUNTRY"))
