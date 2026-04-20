// Conventional Commits enforced locally (lefthook commit-msg) and in CI.
// Drives release-please: feat → minor, fix → patch, BREAKING CHANGE → major.
// See https://www.conventionalcommits.org/en/v1.0.0/
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'docs',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
        'release',
      ],
    ],
    'scope-enum': [
      1,
      'always',
      [
        'ts',
        'go',
        'admin',
        'interop',
        'http',
        'storage',
        'crypto',
        'cli',
        'client',
        'docs',
        'ci',
        'deps',
        'release',
      ],
    ],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [1, 'always', 100],
  },
};
