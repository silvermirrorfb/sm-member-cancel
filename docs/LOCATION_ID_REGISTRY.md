# Boulevard Location ID Registry

Authoritative Silver Mirror storefront IDs used by the bot runtime.

| Location | Boulevard Location ID |
|---|---|
| Brickell | `urn:blvd:Location:24a2fac0-deef-4f7f-8bf6-52368be42d65` |
| Bryant Park | `urn:blvd:Location:c80e43fc-22f5-4adf-b406-f50f59a85b80` |
| Coral Gables | `urn:blvd:Location:01b80da8-0b5e-440a-b18b-03afbf5686bd` |
| Dupont Circle | `urn:blvd:Location:b11142af-3d1a-4d11-8194-0c50d023fd75` |
| Flatiron | `urn:blvd:Location:9482e4e3-e33a-4e31-baa1-9d14acb6c1c8` |
| Manhattan West | `urn:blvd:Location:bee8d08c-1a4b-4d7d-bf59-94b9dcd1523f` |
| Navy Yard | `urn:blvd:Location:ce941e99-975b-4d98-9343-3139260821bb` |
| Penn Quarter | `urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa` |
| Upper East Side | `urn:blvd:Location:5feecb61-9bcb-458a-ab42-09478386adbb` |
| Upper West Side | `urn:blvd:Location:6eab61bf-d215-4f4f-a464-6211fa802beb` |

## Runtime normalization behavior
- Accepts full URNs, bare UUIDs, and known location names/aliases (for example `UWS`, `Dupont`, `Penn Quarter`).
- Auto-normalizes bare UUIDs to `urn:blvd:Location:<uuid>`.
- Remaps known legacy IDs to current canonical IDs.
- Rejects unknown plain-text location inputs for route overrides (fails safe by ignoring the override).

## Current built-in legacy remap
- `urn:blvd:Location:79afa932-6e84-49c7-9f0f-605c680599cc` -> `urn:blvd:Location:79afa932-b486-4fe9-8502-d805a9e48caa`

## Optional env overrides
- `BOULEVARD_LOCATION_REMAP_JSON` (JSON object or array of pairs)
- `BOULEVARD_LOCATION_ALIAS_GROUPS_JSON` (JSON array of ID groups)

Safety note: alias groups that merge two known, different storefront IDs are ignored at runtime.
