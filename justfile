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

# Prepare a minor, major, or exact version for the next merge; never publish locally.
[positional-arguments]
bump target:
    node scripts/release.mjs bump "$1"

repo-checks:
    test -d .jj || jj git init --colocate
    shaka whitespace check
    shaka preflight --keep-going
    nixfmt --check flake.nix
    nix flake check
    nix flake check --all-systems --no-build

validate: typecheck lint format-check coverage repo-checks

commit-check:
    shaka commit lint -r 'root()..@-'

# Run the Node 22 compatibility lane with the same locked environment as CI.
compat:
    nix develop .#node22 --command just validate
