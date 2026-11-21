default:
    @just --list
install:
    npm ci --ignore-scripts
typecheck:
    npm run typecheck
lint:
    npm run lint
format-check:
    npm run format:check
format:
    npm run format
    nixfmt flake.nix
    taplo fmt
test:
    npm test
coverage:
    npm run coverage
build:
    npm run build
repo-checks:
    test -d .jj || jj git init --colocate
    shaka whitespace check
    shaka preflight --keep-going
    nixfmt --check flake.nix
    nix flake check
    nix flake check --all-systems --no-build
validate: typecheck lint format-check coverage build repo-checks
compat:
    nix develop .#node22 --command just validate
commit-check:
    shaka commit lint -r 'root()..@-'
