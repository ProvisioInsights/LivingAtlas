# Data Source Intake

Living Atlas can ingest private source material from notes, email, calendar,
travel tools, reservation systems, exports, and manually reviewed files. The
same privacy rules apply to every source: raw evidence stays local-private
unless an operator explicitly marks a derived fact as remote-readable.

## Source Classes

| Class | Examples | Default access | Promotion rule |
| --- | --- | --- | --- |
| `notes` | Logseq, Obsidian, markdown | `local-private` | Promote only explicit schema-valid facts or reviewed candidates. |
| `messages` | Email, chat, meeting transcripts | `local-private` | Promote only when sender/source, date, and target fact are clear. |
| `calendar` | Calendar events, invites, ICS files | `local-private` | Preserve RFC 5545 time fields; conflicts become review records. |
| `travel` | TripIt, Flighty, airline, hotel, rental exports | `local-private` | Treat itinerary aggregators as evidence; prefer direct carrier/hotel exports for final details. |
| `commerce` | Receipts, invoices, subscriptions, payments | `local-private` | Promote only high-confidence purchase/provider/item facts. |
| `documents` | PDFs, presentations, files, photos | `local-private` | Import as source/artifact evidence first; promote typed graph facts separately. |

## Evidence Ranking

Use higher-ranked evidence to resolve conflicts, but never discard lower-ranked
evidence. Keep every source connected to the derived object so audits can show
why a fact exists.

1. Provider export or direct account record.
2. Provider confirmation email or receipt.
3. Calendar invite or attached ICS file.
4. Aggregator import such as TripIt or Flighty.
5. Freeform note or memory.
6. Inferred fact from surrounding prose.

## Normalization Targets

Travel and commerce enrichment should normalize into the existing endpoint
types instead of inventing one-off shapes:

- `organization`: carrier, hotel group, vendor, merchant, agency.
- `location`: airport, hotel, venue, city, address.
- `occurrence`: flight, hotel stay, meeting, event, reservation window.
- `offering`: fare class, travel class, room type, service, product, package.
- `item`: ticket, reservation, receipt, seat, room instance, purchased object,
  created work, deliverable.
- `topic`: controlled subject only after review.

Edges should use the registry before adding a new predicate:

- `offered-by`: offering to organization.
- `instance-of`: item to offering.
- `purchased`: person or organization to offering or item.
- `purchased-from`: person or organization to organization.
- `owns`: person or organization to item.
- `occurred-at`: occurrence to location.
- `created`: person or organization to item or offering.
- `created-for`: item or offering to person, organization, project, or offering.

## Conflict Handling

Provider records can still be wrong or incomplete. When two sources disagree,
Living Atlas should create a review candidate rather than overwrite silently.
Use these conflict fields in local-private review packets and import ledgers:

- `source_rank`: evidence rank from the list above.
- `source_observed_at`: when the evidence was collected.
- `fact_effective_time`: when the fact claims to be true.
- `conflict_group`: stable hash joining candidates about the same object.
- `terminal_decision`: `promote`, `defer`, `reject`, or `supersede`.

## Provider Data Requests

Many travel, hotel, and commerce companies provide privacy request portals or
support channels for access/export requests. Availability and exact rights vary
by jurisdiction, account type, and provider. Operators should first use the
provider's official privacy portal; when no export exists, send a narrow access
request asking for machine-readable reservation, transaction, loyalty, and
profile data.

Request only what Living Atlas can safely normalize:

- account profile and loyalty identifiers
- reservation and itinerary history
- receipts, folios, invoices, and refunds
- purchased products/services and classes
- dates, times, locations, confirmation numbers, and status changes
- data dictionary or field descriptions when available

Do not put provider credentials, account numbers, confirmation numbers, or raw
exports in the public repo. Store raw exports in the private local evidence
area, generate a local-private connector packet, and import only encrypted
objects after review.

## Request Template

```text
Subject: Request for copy of personal data and account records

Hello,

I am requesting a copy of the personal data associated with my account,
including account profile data, loyalty data, reservation history, itinerary
records, receipts, invoices, refunds, products or services purchased, status
changes, and any available machine-readable export or data dictionary.

Please include records tied to my account email address and any loyalty or
reservation identifiers I provide through your secure verification process.
If a self-service privacy portal or secure upload is required, please direct me
there.

Please provide the data in a machine-readable format such as CSV, JSON, XML, or
ICS where available.

Thank you.
```

## Local Workflow

1. Collect provider exports or confirmation files into a private local evidence
   folder outside this repository.
2. Generate a local-private review packet for the source class.
3. Group related candidates into review units before making decisions.
4. Generate or edit a local-private resolution map for grouped candidates.
5. Promote only high-confidence reviewed facts with schema-valid endpoint or
   edge payloads.
6. Import promoted facts into encrypted local objects.
7. Keep held candidates as encrypted quarantine/review records.
8. Sync only according to the object's access class and key policy.
