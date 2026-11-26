export interface PackageBundle {
  manifest: any;
  scoring: any;
  verification: any;
}

interface Family {
  assignmentId: string;
  title: string;
  description: string;
  split: 'development' | 'held_out';
  format: 'function' | 'script';
  entryPoint?: string;
  criteria: { id: string; description: string; expectedBehavior: string }[];
  tests: Record<string, string>[];
}

const FAMILIES: Family[] = [
  {
    assignmentId: 'range-count',
    title: 'Count values inside a range',
    description:
      'Implement count_in_range(values, low, high). Return how many values are at least low and at most high.',
    split: 'development',
    format: 'function',
    entryPoint: 'count_in_range',
    criteria: [
      {
        id: 'inclusive-bounds',
        description: 'Inclusive bounds',
        expectedBehavior: 'Both endpoints count as inside the range.',
      },
      {
        id: 'single-pass',
        description: 'Single pass',
        expectedBehavior: 'Visits each value once and returns a count.',
      },
    ],
    tests: [
      { id: 'both-bounds', arguments: '[[1, 2, 3, 4], 2, 3]', expectedReturn: '2' },
      { id: 'no-values', arguments: '[[]]', expectedReturn: '0' },
    ],
  },
  {
    assignmentId: 'line-total',
    title: 'Total a column of numbers',
    description:
      'Read one integer per line from standard input and print the total.',
    split: 'development',
    format: 'script',
    criteria: [
      {
        id: 'reads-eof',
        description: 'Reads to EOF',
        expectedBehavior: 'Reads every line instead of only the first.',
      },
      {
        id: 'exact-output',
        description: 'Exact output',
        expectedBehavior: 'Prints only the total followed by a newline.',
      },
    ],
    tests: [
      { id: 'two-values', stdin: '1\n2\n', expectedStdout: '3\n' },
      { id: 'empty-input', stdin: '', expectedStdout: '0\n' },
    ],
  },
  {
    assignmentId: 'first-match',
    title: 'Find the first match',
    description:
      'Implement first_name_containing(names, needle). Return the first name containing needle, or None.',
    split: 'held_out',
    format: 'function',
    entryPoint: 'first_name_containing',
    criteria: [
      {
        id: 'order',
        description: 'Input order',
        expectedBehavior: 'Returns the first matching name in input order.',
      },
      {
        id: 'no-match',
        description: 'No match',
        expectedBehavior: 'Returns None when nothing matches.',
      },
    ],
    tests: [
      { id: 'matches-second', arguments: '[["ada", "grace", "alan"], "ra"]', expectedReturn: '"grace"' },
      { id: 'no-match', arguments: '[["ada"], "zz"]', expectedReturn: 'null' },
    ],
  },
  {
    assignmentId: 'classify-lines',
    title: 'Classify input lines',
    description:
      'Read one integer per line and print even, odd, or invalid for each line in order.',
    split: 'held_out',
    format: 'script',
    criteria: [
      {
        id: 'per-line',
        description: 'One result per line',
        expectedBehavior: 'Prints exactly one classification for each input line.',
      },
      {
        id: 'invalid-input',
        description: 'Invalid input',
        expectedBehavior: 'Prints invalid for a line that is not an integer.',
      },
    ],
    tests: [
      { id: 'mixed', stdin: '2\n3\n', expectedStdout: 'even\nodd\n' },
      { id: 'invalid', stdin: 'x\n', expectedStdout: 'invalid\n' },
    ],
  },
];

interface CaseSeed {
  id: string;
  family: string;
  split: 'development' | 'held_out';
  versions: ('single' | 'original' | 'corrected')[];
  targeted?: string[];
  sourceBug?: string;
}

const CASES: CaseSeed[] = [
  { id: 'dev-fn-clean', family: 'range-count', split: 'development', versions: ['single'] },
  {
    id: 'dev-fn-fix',
    family: 'range-count',
    split: 'development',
    versions: ['original', 'corrected'],
    targeted: ['off-by-one'],
  },
  {
    id: 'dev-fn-partial',
    family: 'range-count',
    split: 'development',
    versions: ['original', 'corrected'],
    targeted: ['inverted-test'],
    sourceBug: 'source-evident',
  },
  { id: 'dev-io-clean', family: 'line-total', split: 'development', versions: ['single'] },
  {
    id: 'dev-io-fix',
    family: 'line-total',
    split: 'development',
    versions: ['original', 'corrected'],
    targeted: ['inclusive-total'],
  },
  {
    id: 'dev-io-partial',
    family: 'line-total',
    split: 'development',
    versions: ['original', 'corrected'],
    targeted: ['no-newline'],
    sourceBug: 'source-evident',
  },
  { id: 'held-fn-clean', family: 'first-match', split: 'held_out', versions: ['single'] },
  {
    id: 'held-fn-fix',
    family: 'first-match',
    split: 'held_out',
    versions: ['original', 'corrected'],
    targeted: ['last-match'],
  },
  {
    id: 'held-fn-partial',
    family: 'first-match',
    split: 'held_out',
    versions: ['original', 'corrected'],
    targeted: ['case-sensitive'],
    sourceBug: 'source-evident',
  },
  { id: 'held-io-clean', family: 'classify-lines', split: 'held_out', versions: ['single'] },
  {
    id: 'held-io-fix',
    family: 'classify-lines',
    split: 'held_out',
    versions: ['original', 'corrected'],
    targeted: ['single-line'],
  },
  {
    id: 'held-io-partial',
    family: 'classify-lines',
    split: 'held_out',
    versions: ['original', 'corrected'],
    targeted: ['invalid-handling'],
    sourceBug: 'source-evident',
  },
];

function sourceFor(seed: CaseSeed, version: string, family: Family): string {
  const bug = version === 'corrected' ? 'clean' : seed.targeted?.[0] ?? 'clean';
  if (family.format === 'function') {
    if (family.entryPoint === 'first_name_containing') {
      const bodies: Record<string, string> = {
        clean: 'return next((name for name in names if needle in name), None)',
        'last-match': 'matches = [name for name in names if needle in name]\n    return matches[-1] if matches else None',
        'case-sensitive': 'return next((name for name in names if needle.lower() in name.lower()), None)',
      };
      return `def first_name_containing(names, needle):\n    ${bodies[bug] ?? bodies.clean!}\n`;
    }
    const bodies: Record<string, string> = {
      clean: 'return sum(1 for value in values if low <= value <= high)',
      'off-by-one': 'return sum(1 for value in values if low < value < high)',
      'inverted-test': 'return sum(1 for value in values if low <= value < high)',
    };
    return `def ${family.entryPoint}(values, low, high):\n    ${bodies[bug] ?? bodies.clean!}\n`;
  }
  if (family.assignmentId === 'classify-lines' && bug === 'clean') {
    return "import sys\nfor line in sys.stdin:\n    try:\n        value = int(line)\n    except ValueError:\n        print('invalid')\n    else:\n        print('even' if value % 2 == 0 else 'odd')\n";
  }
  const bodies: Record<string, string> = {
    clean: "import sys\n\ntotal = 0\nfor line in sys.stdin:\n    if line.strip():\n        total += int(line)\nprint(total)\n",
    'inclusive-total': "import sys\n\nlines = sys.stdin.read().splitlines()\nprint(sum(int(line) for line in lines[:-1]) if lines else 0)\n",
    'no-newline': "import sys\n\nprint(sum(int(line) for line in sys.stdin if line.strip()), end='')\n",
    'single-line': "line = input()\nvalue = int(line)\nprint('even' if value % 2 == 0 else 'odd')\n",
    'invalid-handling': "for line in __import__('sys').stdin:\n    print('even' if int(line) % 2 == 0 else 'odd')\n",
  };
  return bodies[bug] ?? bodies.clean!;
}

export function validPackageBundle(options: { minimal?: boolean } = {}): PackageBundle {
  const seeds = options.minimal
    ? CASES.filter((seed) => seed.id.endsWith('-clean') || seed.id === 'dev-fn-fix' || seed.id === 'dev-fn-partial')
    : CASES;
  const assignments: Record<string, unknown> = {};
  for (const family of FAMILIES) {
    assignments[family.assignmentId] = {
      title: family.title,
      description: family.description,
      format: family.format,
      ...(family.entryPoint === undefined ? {} : { entryPoint: family.entryPoint }),
      criteria: family.criteria,
      tests: family.tests,
    };
  }

  const submissions: Record<string, { text: string }> = {};
  const cases = seeds.map((seed) => {
    const family = FAMILIES.find((value) => value.assignmentId === seed.family)!;
    return {
      id: seed.id,
      familyId: `family-${seed.family}`,
      split: seed.split,
      assignmentId: seed.family,
      submissions: seed.versions.map((version) => {
        const path = `cases/${seed.id}/${version}.py`;
        submissions[path] = { text: sourceFor(seed, version, family) };
        return { version, path, assignmentRevision: '1' };
      }),
    };
  });

  const scoringCases: Record<string, unknown> = {};
  for (const seed of seeds) {
    const family = FAMILIES.find((value) => value.assignmentId === seed.family)!;
    const caseSubmissions: Record<string, unknown> = {};
    for (const version of seed.versions) {
      const path = `cases/${seed.id}/${version}.py`;
      const remaining = seed.sourceBug === undefined
        ? []
        : [{
            id: seed.sourceBug,
            requirement: family.criteria[1]!.id,
            evidence: [{ kind: 'source', path, startLine: 2, endLine: 2 }],
            note: 'Remains after the targeted fix.',
          }];
      const errors = version === 'corrected'
        ? remaining
        : version === 'single'
          ? []
          : [
              {
                id: seed.targeted![0],
                requirement: family.criteria[0]!.id,
                evidence: [
                  { kind: 'source', path, startLine: 1, endLine: 2 },
                  { kind: 'test', testId: family.tests[0]!.id },
                ],
                note: 'The source contradicts the requirement.',
              },
              ...remaining,
            ];
      caseSubmissions[version] = { clean: errors.length === 0, errors };
    }
    scoringCases[seed.id] = {
      ...(seed.targeted === undefined ? {} : { targetedErrorIds: seed.targeted }),
      submissions: caseSubmissions,
    };
  }

  const verificationCases: Record<string, unknown> = {};
  for (const seed of seeds) {
    verificationCases[seed.id] = {
      authoringChecks: [
        {
          id: 'study-suite-covers-requirement',
          status: 'pass',
          note: 'The supplied study suite distinguishes the original and corrected versions.',
        },
      ],
    };
  }

  return {
    manifest: {
      format: 1,
      datasetId: 'intro-python-paired',
      revision: '2026-11-27.1',
      assignments,
      cases,
      submissions,
    },
    scoring: {
      datasetId: 'intro-python-paired',
      revision: '2026-11-27.1',
      cases: scoringCases,
    },
    verification: {
      datasetId: 'intro-python-paired',
      revision: '2026-11-27.1',
      cases: verificationCases,
    },
  };
}
