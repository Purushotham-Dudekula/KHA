# Contributing Guide

Thank you for contributing to our project! To maintain code quality and consistency, please follow these guidelines.

## Branch Naming Conventions
- **New Features**: `feature/ticket-desc` (e.g., `feature/payment-gateway`)
- **Bug Fixes**: `bugfix/ticket-desc` (e.g., `bugfix/login-error`)
- **Urgent Fixes**: `hotfix/desc` (e.g., `hotfix/db-connection-leak`)

## Pull Request Requirements
- **Reviewers**: At least 1 reviewer must approve the PR before merging.
- **CI/CD**: All CI checks (linting, tests, builds) must pass.
- **Main Protection**: No direct pushes to the `main` branch are allowed. All changes must go through a PR.

## Commit Message Format
We follow the conventional commits specification: `type(scope): description`
- **feat**: A new feature
- **fix**: A bug fix
- **chore**: Maintenance tasks, dependency updates, etc.
- **test**: Adding or correcting tests
- **docs**: Documentation changes
- **refactor**: Code changes that neither fix a bug nor add a feature

## Development Workflow
1.  Create a new branch from `main`.
2.  Implement your changes.
3.  **Run tests locally** before pushing:
    ```bash
    npm test
    ```
4.  **Check code coverage**:
    ```bash
    npm test -- --coverage
    ```
5.  Push your branch and open a Pull Request.

## Quality Standards
- Ensure 100% test pass rate.
- Maintain or increase test coverage.
- Use the provided PR template to document your changes.
