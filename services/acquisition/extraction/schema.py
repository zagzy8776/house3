"""
Structured-output schemas for API providers.

Exa's `contents.summary.schema` takes a JSON schema and returns an LLM-written
object matching it. That is exactly the shape the acquisition pipeline wants -
except for one thing. Every field we put in that schema is a field we have
collected. Put `description` in it and Exa will write us a summary of someone
else's listing copy, and the output allowlist will happily store it because the
key was declared.

So the schema is DERIVED from ALLOWED_FIELDS, and this module asserts that at
import time. Adding a field to `EXA_SUMMARY_FIELDS` that is not in
ALLOWED_FIELDS is an ImportError, not a code review comment. The same is true of
anything in FORBIDDEN_FIELDS - the module refuses to load.

That is the whole point: a vendor API that can be asked for arbitrary text is a
bigger hole than a regex, and it should be closed structurally.
"""

from __future__ import annotations

from typing import Any

from compliance.allowed_fields import ALLOWED_FIELDS, FORBIDDEN_FIELDS, PolicyViolation

#: The subset of ALLOWED_FIELDS worth asking a search index for. Discovery is
#: broad and shallow - we want enough to decide whether a page is worth a real
#: crawl; full extraction happens later against the operator's own page.
#:
#: Deliberately absent, and staying absent: any media, any prose, and also
#: `title_document`. A title document is a legal fact we take from an operator
#: who has signed, not something an LLM infers from a listing page.
EXA_SUMMARY_FIELDS = frozenset(
    {
        "operator_name",
        "phone",
        "email",
        "website",
        "instagram",
        "pms_detected",
        "booking_url",
        "property_name",
        "property_type",
        "bedrooms",
        "bathrooms",
        "advertised_price",
        "currency",
        "state",
        "city",
        "area",
    }
)


def _assert_declared(fields: frozenset[str], label: str) -> None:
    forbidden = fields & FORBIDDEN_FIELDS
    if forbidden:
        raise PolicyViolation(
            f"{label} requests forbidden fields {sorted(forbidden)}. Structured "
            "output from a search API is still collection - a vendor is not a licence."
        )

    undeclared = fields - ALLOWED_FIELDS
    if undeclared:
        raise PolicyViolation(
            f"{label} requests fields not in ALLOWED_FIELDS: {sorted(undeclared)}. "
            "Add them to ALLOWED_FIELDS deliberately, or drop them from the schema."
        )


# Enforced at import. A schema that reaches outside the allowlist stops the
# service from starting rather than leaking one field per run.
_assert_declared(EXA_SUMMARY_FIELDS, "EXA_SUMMARY_FIELDS")


#: Human-readable intent per field. The description is what steers the model, so
#: it says what to extract and, where it matters, what to refuse.
_FIELD_DESCRIPTIONS: dict[str, str] = {
    "operator_name": "The business or agency marketing this property. Not an individual agent's name.",
    "phone": "Contact phone number in international format, e.g. +234...",
    "email": "Contact email address.",
    "website": "The operator's own website domain, if distinct from the listing portal.",
    "instagram": "The operator's Instagram handle.",
    "pms_detected": "Booking or property-management system in use, if any, e.g. 'guestpro'.",
    "booking_url": "A URL where a guest can pay to book this property. Omit if booking is by phone only.",
    "property_name": "Name of the property or building, if given.",
    "property_type": "One of: apartment, duplex, bungalow, house, villa, serviced_apartment.",
    "bedrooms": "Number of bedrooms as an integer.",
    "bathrooms": "Number of bathrooms as an integer.",
    "advertised_price": "The advertised price exactly as shown, digits only.",
    "currency": "ISO 4217 code, e.g. NGN.",
    "state": "Nigerian state name.",
    "city": "City or town.",
    "area": "Neighbourhood, e.g. Lekki Phase 1, Ikoyi, Wuse 2.",
}

_INTEGER_FIELDS = frozenset({"bedrooms", "bathrooms"})


def assert_schema_is_clean(schema: dict[str, Any]) -> dict[str, Any]:
    """
    Re-check a schema right before it goes over the wire.

    Redundant against the import-time assertion on purpose: schemas get built
    dynamically by callers who may add a field for a one-off run, and this
    catches that without waiting for a reviewer to notice.
    """
    properties = (schema or {}).get("properties") or {}
    _assert_declared(frozenset(properties), "output schema")
    return schema


def exa_summary_schema(
    fields: frozenset[str] | None = None,
    *,
    require: frozenset[str] | None = None,
) -> dict[str, Any]:
    """
    A JSON schema for Exa's `contents.summary.schema`.

    `require` names the fields without which a discovery result is useless. The
    default requires nothing, because a hard requirement on a field is what makes
    a model invent one - `phone` is the field most worth having and the one it
    would most readily hallucinate. Better to receive a null and go look.
    """
    selected = fields if fields is not None else EXA_SUMMARY_FIELDS
    _assert_declared(frozenset(selected), "exa_summary_schema")

    properties: dict[str, Any] = {}
    for name in sorted(selected):
        description = _FIELD_DESCRIPTIONS.get(name, f"Extract {name}.")
        field_type = ["integer", "null"] if name in _INTEGER_FIELDS else ["string", "null"]
        properties[name] = {"type": field_type, "description": description}

    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "ShortletOperatorSignals",
        "type": "object",
        "properties": properties,
        "required": sorted(require or frozenset()),
        # Said outright, because the model reads this and because it is the rule.
        "description": (
            "Facts about a shortlet operator and the advertised rate. Report only "
            "what is stated on the page. Do not summarise, paraphrase or quote the "
            "listing text, and do not describe any photographs. Return null for "
            "anything not stated rather than inferring it."
        ),
    }
