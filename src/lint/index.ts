import { LintRule } from './types'
import { noContextRule } from './rules/noContext'
import { vagueScopeRule } from './rules/vagueScope'
import { multiSkillRule } from './rules/multiSkill'
import { unknownSkillRule } from './rules/unknownSkill'
import { longPromptRule } from './rules/longPrompt'
import { unresolvedFileRefRule } from './rules/unresolvedFileRef'
import { outsideWorkspaceRule } from './rules/outsideWorkspace'
import { duplicateSkillRule } from './rules/duplicateSkill'
import { missingTabstopsRule } from './rules/missingTabstops'

export { LintRule, LintContext } from './types'
export { findFileRefs, findSkillInvocations } from './scanners'

export const ALL_RULES: LintRule[] = [
  noContextRule,
  vagueScopeRule,
  multiSkillRule,
  unknownSkillRule,
  longPromptRule,
  unresolvedFileRefRule,
  outsideWorkspaceRule,
  duplicateSkillRule,
  missingTabstopsRule,
]
