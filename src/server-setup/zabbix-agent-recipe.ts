/** SHA256 digests of the reviewed standalone 20-agent-psk recipe after buildCombinedRecipeBody.
 * Updating the recipe requires reviewing and synchronizing these digests and the fixture
 * (the API keeps the same list). Earlier revisions stay listed so that a recipe stored
 * before the update, and the completion evidence it produced, keep verifying while the
 * CLI, the API and the stored recipe are rolled out independently.
 * Never derive trust from an Agent result or a tenant-supplied expected hash.
 */
export const ZABBIX_AGENT_RECIPE_BODY_SHA256S: readonly string[] = [
  // Accepts installed Agent 6.0 / 7.0.
  '3eb42f67267dd6658588a9a45bac523e365e9f10106715757defbc8c1afa0c12',
  // Also accepts installed Agent 8.0 (previous fixture, retained for rollout).
  '5449ec3fc2c11ac7b33df0f52d35bddd5a5033cd9551b2fb2d2cf394ffbf303c',
  // Also admits the exact root-owned Rundeck persistent-buffer Include.
  'fb688303666d3fd9dd075309a60edee2871d6cd1788364b19feace37143fcc76',
]

/** Dedicated consumer names; extra-vars must not override role internals/registers. */
export const ZABBIX_AGENT_RECIPE_VARIABLES = [
  'ZABBIX_BINDING_ID',
  'ZABBIX_EXPECTED_MACHINE_ID',
  'ZABBIX_PSK',
  'ZABBIX_PSK_IDENTITY',
  'ZABBIX_SERVER_ACTIVE',
] as const
