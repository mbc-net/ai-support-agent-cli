/** SHA256 of the reviewed standalone 20-agent-psk recipe after buildCombinedRecipeBody.
 * Updating the recipe requires reviewing and synchronizing this digest and fixture.
 * Never derive trust from an Agent result or a tenant-supplied expected hash.
 */
export const ZABBIX_AGENT_RECIPE_BODY_SHA256 =
  '3eb42f67267dd6658588a9a45bac523e365e9f10106715757defbc8c1afa0c12'

/** Dedicated consumer names; extra-vars must not override role internals/registers. */
export const ZABBIX_AGENT_RECIPE_VARIABLES = [
  'ZABBIX_BINDING_ID',
  'ZABBIX_EXPECTED_MACHINE_ID',
  'ZABBIX_PSK',
  'ZABBIX_PSK_IDENTITY',
  'ZABBIX_SERVER_ACTIVE',
] as const
