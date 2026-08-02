# Boron Content review

## One local place for all three layers

Boron Content keeps each source in its own lane while giving people one review surface:

- **Ontology** shows PostgreSQL entities and current relations as a clickable graph.
- **Codebase Memory** keeps ownership of symbols, calls, dependencies, and the maintained 3D graph.
- **OpenWiki** presents narrative project knowledge as readable documentation.

## Human correction lifecycle

A field edit or note becomes a revisioned pending correction. It does not silently overwrite source
facts. The next Boron-enabled agent treats it as high-priority human evidence, verifies the current
sources, repairs or rejects the affected relationship, and closes the correction with an audit
summary.

## Runtime contract

Boron Content owns no LLM calls. Retrieval, project scoping, Inspector authentication, and the
manual-correction queue remain deterministic and local.
