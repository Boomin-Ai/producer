# Boomin adapter

| Boomin source | Portable meaning |
| --- | --- |
| `universes`, `universe_entities`, `universe_entity_files` | World, typed creative entity, ordered references. Resolve files into package assets. Tenant-local IDs are provenance. |
| Series collection, episode unit, `unit_parts` | Show context, production work and authored shot/segment/slide intent. The playable segment's sequence supplies timing. |
| `promptDoc`, `unit_part_entities`, `unit_part_takes` | Prompt and UTF-16 mentions, cast links and alternate results with model/prompt receipts. |
| `content_collaborators` | A credited actor can be a person, entity, or brand. Producer additionally identifies the exact timed placement. |
| Unit stage, per-part status, unit review comments | Distribution state, creative progress and human review are separate. A scheduled Boomin post alone cannot complete or approve a production. |
| `boomin.workspace.v2` | The bundled adapter exports entities and one prompt sheet with typed local references. An installer resolves its own slots and access grants. |

The offline adapter emits the actual Boomin workspace resource shape. It projects the shot sheet into `objects.entities` and `objects.prompt_sheets`. A receiver can retain the complete signed Producer package alongside this projection. Uploading media, provisioning an account, installing a template in Boomin and making a paid model call are explicit adapter actions. The portable sample includes optional `ai.boomin` metadata. An implementation can exchange, edit and verify the whole production without contacting Boomin.
