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

test:
    npm test

coverage:
    npm run coverage

validate: typecheck lint format-check coverage

shaka *args:
    nix run 'https://flakehub.com/f/kolohelios/shaka/*.tar.gz' -- {{args}}
