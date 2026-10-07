# 25. Measure JavaScript and TypeScript from a syntax tree

Date: 2026-10-07

## Status

Accepted

## Context

Lizard reads source with a tokeniser and no grammar, so it loses function boundaries when a TypeScript construct looks like something else. Run over every JavaScript and TypeScript file in this repository, lizard 1.24 reported 4,102 functions where a syntax tree finds 4,527. It reported 0 parameters for 993 arrow functions and counted one extra line for 400 functions by adding the first line of the next statement. It also lost boundaries in production files. `hoursBetween` in `packages/core/src/stats.ts` spans lines 3 to 7 but lizard ended it at line 5, apparently reading the `/` as a regular expression, and so missed its ternary and reported a CCN of 3 rather than 4. `stageMeans` in `packages/core/src/report.ts` has 9 lines and was reported with 19, because it ran on into the interface below. Line numbers in `packages/core/src/codeTooling.ts` drift by one from about line 250, and `TestingPanel` in `apps/web/src/components/CodeHealthSection.tsx` was given a CCN of 7 against a true 6 because `)?.met` was counted as a branch. Lizard does count `&&` and `?` inside JSX correctly in ordinary components, so the fault is lost boundaries and tokeniser accidents rather than missed conditions.

ADR 0015 answered part of this with a text heuristic that flagged files holding a JSX spread attribute. That heuristic names a file and not the functions that are missing, and the evidence above shows the problem is wider than JSX spread.

## Decision

JavaScript and TypeScript are measured in process from a syntax tree. Every other language still goes through lizard.

- `BabelAnalyser` (`apps/api/src/infrastructure/babel/babel-analyser.ts`) implements `CodeAnalyser`. It lists the clone through `WorkspaceReader`, keeps `.ts .tsx .mts .cts .js .jsx .mjs .cjs`, skips `.d.ts`, `.d.mts`, `.d.cts` and `*.min.js`, `*.min.mjs`, `*.min.cjs`, and reads each file up to 2 MiB. It yields to the event loop between files and stops after 10 minutes with the message lizard's timeout uses. A file that is too large, unreadable or parsed only with error recovery is listed in `partlyMeasured`.
- `measureSource(path, source)` (`apps/api/src/infrastructure/babel/measure-source.ts`) is a pure function that parses one file with `@babel/parser` 7.29 and returns the functions and whether the parse was clean.
- `CombinedAnalyser` (`apps/api/src/infrastructure/analysis/combined-analyser.ts`) sends JavaScript and TypeScript to the Babel analyser and everything else to lizard. It runs both at once with `Promise.allSettled`, so the clone is never removed while lizard is still reading it, and then rethrows the first failure. A lizard failure therefore still fails the whole analysis, as ADR 0011 decided, rather than saving the JavaScript and TypeScript figures alone. A missing lizard is a lasting condition that the page explains, whereas a failure such as a timeout is usually passing, and the last complete figures shown beside the error read truer than a new snapshot whose grade covers only some of the languages. `main.ts` and `cli.ts` build it with `new LizardAnalyser(SCRIPT_EXTENSIONS)`, which adds `-x "*.<ext>"` for each script extension so lizard does not read them twice.
- Lizard is optional for a repository that holds only JavaScript and TypeScript. When it is not installed the scripts are still measured, and the files lizard would have read (core's `isCodeFile` and not a script extension) are counted as `unmeasuredFiles`. The port's `CodeAnalysis`, `CodeSnapshot` and `CodeHealthReport` carry that count, and the web shows install commands when it is above zero.
- `languageOf`, `SCRIPT_EXTENSIONS` and `isScriptPath` live in `apps/api/src/infrastructure/analysis/languages.ts`.
- The JSX spread heuristic (`hasJsxSpread`) and the partly measured scan in the lizard adapter are removed. `partlyMeasured` now lists files that failed to parse cleanly or were too large, and the next band advice and hotspot shapes of ADR 0015 are unchanged.
- `CODE_SNAPSHOT_VERSION` is 5, so every repository is analysed again on its next crawl even when the branch has not moved.

### Measurement rules

These follow what lizard 1.24's TypeScript reader means to count, made consistent. `docs/metrics.md` states them for readers of the dashboard.

- CCN is 1 plus one for each `if` (so each `else if`), `for`, `for...in`, `for...of`, `while`, `do...while`, `case` with a test, `catch`, ternary, `&&`, `||`, `??`, `&&=`, `||=` and `??=` whose nearest enclosing function is this one. `else`, `default:`, optional chaining, default parameter values, TypeScript conditional types and decorators do not count, and a decorator's branches count to the code around the method.
- Nested functions are measured on their own, so a callback's branches and lines count to the callback and never to the function around it.
- NLOC follows lizard's line rule. A physical line counts once, to the innermost function holding its first code token, and every function also counts its own start line, so `useEffect(() => {` counts for both the component and the callback. A token spanning lines, such as a template literal, counts every line it spans. Comments, blank lines and whitespace-only JSX text never count.
- Each parameter counts once, except that an object or array pattern counts each entry destructured at its top level, as lizard does, so `DateField({ label, value, min, max, onChange })` in `apps/web` is 5. A TypeScript `this` parameter is not counted. Arrow functions report their parameters.
- A function is a declaration, expression, arrow, object method, class method (private, getter, setter or constructor) or class property holding a function. Overload signatures, `declare function`, abstract methods and `.d.ts` files are not functions, and code outside any function is not measured.
- A function with a name of its own uses it, and private names keep their `#`. An unnamed function takes the name it is assigned to, looking through parentheses, `as`, `satisfies`, `!` and any call it is passed into, so `const Card = memo(forwardRef(() => ...))` is `Card`, `exports.run = ...` is `run` and an unnamed default export is `default`. Otherwise a function passed to a call is `<callee> callback`, one in a JSX attribute takes the attribute's name, and anything else is `(anonymous)`. This matters because the `component` hotspot shape is a capitalised name in a `.tsx` or `.jsx` file.
- The start line is the line of the function's name where it has one, otherwise its first token. Language is TypeScript for ts, tsx, mts and cts, and JavaScript for the rest.
- Parser plugins are `typescript` for ts, mts and cts (without `jsx`, so `<T>x` casts parse), `typescript` and `jsx` for tsx, and `jsx` and `flow` (only with an `@flow` pragma) for js, jsx, mjs and cjs. Error recovery is on.
- Babel reads one decorator syntax at a time. Each file is parsed with `decorators-legacy` first, because TypeScript's parameter decorators exist only there. When that reading has errors and the file holds an `@`, it is parsed again with the standard `decorators` and `decoratorAutoAccessors` plugins, which read `export @dec class` and `accessor`, and whichever reading has fewer errors is kept.

### Why Babel 7 and not 8

Babel 8 (8.0.7) is the current major but needs Node ^22.18 or 24.11 and above, and this repository's `engines` floor is 22.13, which CI installs on. The 7.29 line is used until the floor rises. The runtime dependencies are `@babel/parser` and `@babel/types`, both of which were already in the lock file as transitive dependencies.

## Alternatives considered

- **Keep lizard and the JSX spread heuristic.** It costs nothing, but the evidence above shows lost boundaries well beyond JSX spread, and a notice that names a file cannot recover the missing functions.
- **Cross-check lizard against a syntax tree and flag disagreements.** It would keep lizard's figures and still need a full parser, so it carries the cost of both without giving a number a reader can trust.
- **oxc-parser.** It is fast, but it ships a native binary for each platform, which a self-hosted tool installed with plain `npm install` should not need.
- **The TypeScript 5 compiler API.** The workspaces use TypeScript 7, whose package has no in-process parser, so this would need a second aliased copy of the compiler.

## Consequences

### Positive

- Function boundaries, line counts, parameters and CCN for JavaScript and TypeScript come from a grammar, so they no longer depend on tokeniser accidents.
- A repository of JavaScript and TypeScript needs no Python tool at all.
- The partly measured list now names files that really failed to parse, and the heuristic that could flag the wrong file is gone.

### Negative

- CCN now has a second implementation that must be kept in step with lizard's by hand, since both feed the same bands and thresholds.
- `.vue` files still go through lizard and can still be misread.
- Parsing runs on the API's own thread. The analyser yields between files, but one large file still blocks the thread briefly, for about half a second at the 2 MiB limit, and the 10 minute deadline is checked only between files. Moving the parse to a worker thread is the remedy if that ever matters.
- A file that the legacy decorator syntax cannot read and that holds an `@` is parsed twice, and a file mixing parameter decorators with standard decorator syntax is still read only in part.
- JavaScript and TypeScript figures change on the next crawl, so a figure from before this change and one from after are not comparable.
- Two counts differ from lizard on purpose. Lizard counts `a ?? b` as two and `a??b` as one, and the new analyser counts each `??` once. Lizard counts a `this` parameter and the new analyser does not, and lizard reports 0 parameters for most arrow functions where the new analyser reports them.
- A new runtime dependency, on the Babel 7 line until the Node floor allows Babel 8.
