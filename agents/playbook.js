/**
 * Cross-run lessons learned. Injected into agent system prompts so mistakes
 * are not repeated. Add new entries after post-mortems from real runs.
 */

const LESSONS = [
  {
    id: 'router-self-redirect-blank-page',
    tags: ['frontend', 'routing', 'react-router', 'protectedRoute'],
    summary: 'Never redirect a parent route to the path you are already on — child <Outlet> will not render (blank page).',
    wrong: `if (!pin && !isNewUser) {
  return <Navigate to="/pin/set" replace />;
}`,
    right: `if (!pin && !isNewUser && location.pathname !== "/pin/set") {
  return <Navigate to="/pin/set" replace />;
}`,
    rule: 'When a guard uses <Navigate to="X">, always keep location.pathname !== "X" so the destination route can mount its child.',
  },
  {
    id: 'pin-vs-pin-set-distinct-guards',
    tags: ['frontend', 'planner', 'manager', 'routing', 'CT-1495'],
    summary: '/pin (verify) and /pin/set (setup) are different routes — changing one guard must not remove the other.',
    wrong: 'Roadmap says "remove /pin pathname exception" → agent removes ALL pathname checks including /pin/set.',
    right: 'Only adjust the guard for the route being fixed (/pin verify). Keep /pin/set exception so Set PIN form renders.',
    rule: 'In roadmaps and edits, name each pathname exception explicitly. Never "simplify" redirect logic without reading the existing guards first.',
  },
  {
    id: 'syntax-checks-not-routing-proof',
    tags: ['frontend', 'manager', 'verification'],
    summary: 'node -c and npm run build passing does not prove routing works at runtime.',
    wrong: 'Report status ok after syntax/build only; mark PASS without loading /pin/set in browser.',
    right: 'After protectedRoute changes, verify destination pages render (e.g. /pin/set shows set-pin-form). Report blocked if dev server unavailable.',
    rule: 'Routing changes require smoke verification that target URLs render content, not just that redirects occur.',
  },
  {
    id: 'cypress-sudo-retry-trap',
    tags: ['frontend', 'manager', 'qa', 'verification'],
    summary: 'Do not use sudo or retry Cypress in a loop when environment is not ready.',
    wrong: 'sudo chmod on Cypress cache → ETIMEDOUT; retry Cypress 5+ times with different env vars.',
    right: 'One Cypress attempt max if localhost:3000 is confirmed running; otherwise report blocked with manual QA steps.',
    rule: 'Never run sudo. Do not burn tool budget on E2E when cache permissions or dev server are unknown.',
  },
  {
    id: 'read-before-replace',
    tags: ['frontend', 'backend'],
    summary: 'Read the full guard block before replace_in_file — the existing code may already be partially correct.',
    wrong: 'Replace entire redirect block based on roadmap summary without comparing to current snippet.',
    right: 'Use replace_in_file on the smallest diff. Preserve guards that are still required (e.g. /pin/set).',
    rule: 'Match exact old_string from the file. If roadmap wording is ambiguous, prefer the minimal change that fixes the bug.',
  },
  {
    id: 'onboarding-routing-order',
    tags: ['frontend', 'planner', 'CT-1495'],
    summary: 'Onboarding routing decision order must be consistent across App.js, AppsFlyerWrapper, and protectedRoute.',
    wrong: 'Check pin verify before isNewUser or before !pin setup redirect.',
    right: 'Order: isNewUser → /new, then !pin → /pin/set, then pin && !pinVerified → /pin, then app.',
    rule: 'All three files must use the same decision tree. Await hydrateUserState + getProfile before bootstrapped in App.js.',
  },
  {
    id: 'false-pass-with-deferred-qa',
    tags: ['manager', 'planner'],
    summary: 'Do not verdict PASS when verification was blocked and manual QA was not performed by an agent.',
    wrong: 'PASS because "implementation matches roadmap" while Cypress failed and no smoke test ran.',
    right: 'Verdict pass only with evidence, or pass-with-caveats summary listing required manual QA steps explicitly.',
    rule: 'Automated verification blocked → summary must say manual QA required; confidence cannot be high without runtime proof.',
  },
]

function lessonsForTags(tags) {
  return LESSONS.filter(lesson => tags.some(tag => lesson.tags.includes(tag)))
}

function formatLessons(lessons) {
  if (!lessons.length) return ''
  return lessons.map((lesson, i) => {
    const parts = [
      `${i + 1}. [${lesson.id}] ${lesson.summary}`,
      `   Rule: ${lesson.rule}`,
    ]
    if (lesson.wrong) parts.push(`   Wrong: ${lesson.wrong.replace(/\n/g, '\n         ')}`)
    if (lesson.right) parts.push(`   Right: ${lesson.right.replace(/\n/g, '\n          ')}`)
    return parts.join('\n')
  }).join('\n\n')
}

export function playbookSection(role) {
  const tagMap = {
    planner:  ['planner', 'manager', 'frontend', 'routing', 'CT-1495', 'verification'],
    manager:  ['manager', 'frontend', 'verification', 'routing', 'CT-1495'],
    frontend: ['frontend', 'routing', 'react-router', 'protectedRoute', 'CT-1495'],
    backend:  ['backend', 'read-before-replace'],
    qa:       ['qa', 'verification', 'CT-1495'],
  }
  const lessons = lessonsForTags(tagMap[role] ?? [])
  if (!lessons.length) return ''

  return `

Known mistakes — do not repeat (playbook from prior runs):
${formatLessons(lessons)}`
}

export { LESSONS }
