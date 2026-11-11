# Spec: Organize `infra/lib` by responsibility

## Problem Statement

All of the infrastructure code sits in one flat folder that mixes four kinds of code: the CDK stacks, the AppSync resolver and search-mapping helpers, environment and model configuration, and the logic behind the deploy CLI and its pre-deploy checks. A code reviewer on the deployment branch pointed out that this makes it hard to see where one responsibility ends and the next begins.

The flat layout also hides a few places where code reaches across those lines:

- The deploy CLI and the deploy check import the branch naming helpers and the git helpers from the Web stack's file, so deployment code depends on a stack's implementation.
- The Web stack's file mixes three things: the stack construct, the settings that tune it (the platform version, the TLS policy, the bundle exclusions, the sign-in callback path), and the rules for naming and addressing each frontend branch.
- Four files find the Lambda source, the GraphQL schema and the repo root through `__dirname` paths written relative to their own location. Moving any of those files would silently break the paths.

## Solution

Group the infrastructure library into folders by responsibility, so a contributor can tell from the folder alone what a file does and which other files it may depend on:

- **stacks:** the four CDK stacks (API, Auth, Data, Web). They contain only the code that builds resources.
- **appsync:** the resolver code generation and the OpenSearch search mappings.
- **config:** environment configuration, the model list, and a new web configuration module that holds every frontend setting and the branch naming rules.
- **deployment:** the deploy CLI logic and the pre-deploy checks.
- **Root of the library:** the composition root, which plans and builds the app, plus two small modules every folder can use: one for filesystem paths and one for git.

Everything the infrastructure deploys stays exactly the same. The synthesized CloudFormation templates are identical before and after the change.

## User Stories

1. As an infrastructure contributor, I want the CDK stacks in their own folder, so that I can find the definition of any deployed resource without scanning unrelated helpers.
2. As an infrastructure contributor, I want the AppSync resolver and search-mapping code grouped together, so that I can change how GraphQL queries reach DynamoDB and OpenSearch in one place.
3. As an infrastructure contributor, I want the environment and model configuration grouped together, so that I know where to look when adding an environment or a model.
4. As an infrastructure contributor, I want the deploy CLI logic and the pre-deploy checks in their own folder, so that I can work on the deploy workflow without reading stack code.
5. As an infrastructure contributor, I want the composition root to stay at the top of the library, so that the entry point that wires everything together is obvious.
6. As an infrastructure contributor, I want file names to stay the same after the move, so that my existing knowledge and grep habits still work.
7. As a code reviewer, I want the move to be its own commit with no content changes, so that I can check it with rename detection instead of rereading every line.
8. As a code reviewer, I want the extraction of helpers out of the Web stack in a separate commit, so that the real content changes are small and easy to read.
9. As a code reviewer, I want proof that the synthesized templates are unchanged, so that I can approve a large diff without worrying that it changes what gets deployed.
10. As an operator deploying a frontend branch, I want the deploy CLI to behave exactly as before, so that the refactor doesn't disrupt my workflow.
11. As an operator, I want the default certificate, the app domain and the hosted zone in one configuration module, so that I know where to change them.
12. As an operator, I want the Node platform version for Elastic Beanstalk to live in configuration, so that bumping it doesn't mean editing stack code.
13. As an operator, I want the TLS policy to live in configuration, so that tightening it later is a one-line change in an obvious place.
14. As a frontend developer, I want the sign-in callback path and the local dev origin defined in configuration, so that I can find the values the frontend has to match.
15. As an infrastructure contributor, I want the list of files left out of the app bundle to live in configuration, so that I know where to update it when I add a top-level folder to the repo.
16. As an infrastructure contributor, I want the branch naming rules (the slug, the Beanstalk resource name, the domain name) in configuration, so that the stacks, the composition root and the deploy check all share one definition.
17. As an infrastructure contributor, I want the git helpers in a shared module, so that both the Web stack and the deploy CLI can use them without either depending on the other.
18. As an infrastructure contributor, I want one module that defines the infra root, the repo root, the Lambda source folder and the schema file, so that moving a file never silently breaks a path.
19. As an infrastructure contributor, I want deployment code to import nothing from the stack files, so that the boundary between deploying and defining resources stays clear.
20. As an infrastructure contributor, I want to import from each file directly, without barrel index files, so that "go to definition" takes me to the real code and barrels can't introduce import cycles.
21. As a test author, I want the test folder to stay flat, so that the four existing suites stay easy to find.
22. As a test author, I want the existing tests to pass unchanged apart from their imports, so that I can trust them as evidence that behavior didn't change.
23. As a reader of the README, I want its pointer to the default certificate setting to name the new configuration module, so that the instructions stay accurate.
24. As a teammate who raised the feedback, I want the result to match the folders I suggested, so that I can see my review was acted on.

## Implementation Decisions

- **Two commits on the existing deployment branch.** The first only moves files, adds the paths module, and updates imports. The second extracts code out of the Web stack and updates the README. Nothing is pushed without the developer's approval.
- **Folder taxonomy:**
  - **stacks:** API, Auth, Data and Web stacks.
  - **appsync:** resolver code generation and search mappings. The search mappings stay here even though the Data stack also uses them for the OpenSearch index template.
  - **config:** environments, models, and the new web configuration module. The model list lives in configuration, not in its own domain folder, because it is static data like the environments.
  - **deployment:** the deploy CLI logic and the pre-deploy checks.
  - **Library root:** the composition root (which plans and builds the app), the paths module and the git module.
- **File names stay the same,** including the `-stack` and `deploy-` prefixes and suffixes.
- **No barrel or index files.** Imports go straight to the file that defines the export.
- **Paths module:** defines the infra root, the repo root, the Lambda source folder and the GraphQL schema file. Every file that used to compute these from `__dirname` (the API stack, the Data stack, the search mappings and the Web stack) uses this module instead.
- **Git module:** provides the current source commit and the list of uncommitted changes, built on one internal git runner that runs in the repo root (taken from the paths module). The Web stack, the deploy CLI entry point and the app tests use it.
- **Web configuration module** gets three groups of code from the Web stack:
  - **Branch naming:** turning a branch name into a slug, the Beanstalk application/environment name (including its length check and error message), and the branch's public domain name.
  - **Domain constants:** app domain, hosted zone, default certificate ID.
  - **Stack settings:** the Elastic Beanstalk solution stack (the Node platform version), the sign-in callback path, the TLS policy, the list of files left out of the app bundle, and the local dev origin.
- **Rule for the boundary:** configuration holds values and naming rules that can change without changing how resources are built. Stacks hold the construct code that builds resources from those values. After the second commit, the Web stack file contains only the construct.
- **Dependency direction:**
  - Stacks may depend on config, appsync, paths and git.
  - Deployment may depend on config, the composition root and git, but not on stacks.
  - Config depends on nothing else in the library.
  - Appsync depends only on config and paths.
- **No behavior changes:** every exported function keeps its name, signature and output, and every error message stays word-for-word the same.
- **README:** the line about the default certificate points to the web configuration module instead of the Web stack.

## Testing Decisions

- **A good test here checks external behavior:** what gets deployed and what the CLI does. It does not check where code lives. The refactor adds no new tests, because a test of the folder structure itself would only test implementation details.
- **Main check: the synthesized CloudFormation templates.** Before the first commit, synthesize the app for one backend environment plus one frontend branch and save the templates outside the repo. After each commit, synthesize again with the same context and diff the results. They must be identical. This is the highest available check and covers every stack at once.
- **Existing suites:**
  - Run the Jest suites (app synthesis, resolvers, deploy CLI, deploy check) and the Lambda pytest suites after each commit.
  - Tests change only their import paths, which point at the new homes of the exports they use. The test that checks the callback path against the frontend imports it from the web configuration module.
- **Type check:** run the TypeScript compiler with no output after each commit to catch any import that was missed.
- **Prior art:** the app synthesis suite already synthesizes the stacks and asserts on the templates, and it fails if any path from the paths module is wrong. The deploy CLI and deploy check suites already exercise the deploy plan through the composition root.
- **Proof for reviewers:** the PR description states that the templates before and after were identical.

## Out of Scope

- Renaming files, exports, stacks or construct IDs.
- Any change to deployed resources, CloudFormation logical IDs or the deploy CLI's behavior or output.
- Reorganizing the test folder, the Lambda sources, the GraphQL schema or the `bin` entry points (apart from updating their imports).
- Making modules deeper or changing their interfaces beyond moving exports to new homes.
- The pending work on replacing the imported Amplify resources with ones CDK provisions for each environment.

## Further Notes

- This responds to a code-review comment on the deployment branch that suggested folders such as stacks, appsync and deployment. The final layout adds config and keeps a few shared modules at the library root.
- The paths module is what makes this and any future move safe. Without it, a file's `__dirname` paths break silently whenever the file moves.
