# Diagrams

C4 diagrams of the DORA Dashboard, written in [C4-PlantUML](https://github.com/plantuml-stdlib/C4-PlantUML). The `.puml` file is the source and the `.svg` beside it is rendered from it.

| Diagram                                  | C4 level | Shows                                                                                          |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| [System context](c4-system-context.puml) | 1        | Who uses the dashboard, and the systems it depends on: GitHub, the GitHub CLI, git and lizard  |
| [Container](c4-container.puml)           | 2        | The web app, API, crawl CLI, core package, SQLite cache and temporary clone, and how they talk |

![System context](c4-system-context.svg)

![Container](c4-container.svg)

## Rendering

The files include the C4 library that ships with PlantUML (`!include <C4/...>`), so they render without network access.

```bash
brew install plantuml                 # or any PlantUML 1.2023 or later
cd docs/diagrams && plantuml -tsvg *.puml
```

Render again and commit the SVGs after changing a `.puml` file, so the two stay in step. The diagrams follow `apps/api/src/main.ts` and `apps/api/src/cli.ts`, which choose every adapter, so a new adapter there means a change here too. Systems proposed in ADR 0010 but not yet built are left out.
