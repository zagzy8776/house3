/**
 * Nigeria coverage plan.
 *
 * Rollout is deliberately phased: one state cluster fully working (supply,
 * payments, support, payouts) before the next. Phase 1 -> Phase 5 is the five
 * launch states, then the remaining states are listed so the schema never needs
 * reshaping when we expand.
 */

export type StateCode = string;

export type NigerianStateSeed = {
  code: StateCode;
  name: string;
  /** 1..5 = launch states. Higher = expansion waves. */
  phase: number;
  /** 1 = Lagos, the first state switched live. */
  launchOrder: number;
  /** Primary demand city used for the default search box. */
  primaryCity: string;
  /** Neighbourhoods we onboard supply in first, ordered by shortlet demand. */
  areas: readonly string[];
};

/**
 * Launch order: Lagos -> Abuja (FCT) -> Oyo -> Imo -> Akwa Ibom
 */
export const LAUNCH_STATES: readonly NigerianStateSeed[] = [
  {
    code: 'LA',
    name: 'Lagos',
    phase: 1,
    launchOrder: 1,
    primaryCity: 'Lagos',
    areas: [
      'Lekki Phase 1',
      'Lekki Phase 2',
      'Ikoyi',
      'Victoria Island',
      'Oniru',
      'Ajah',
      'Ikate',
      'Ikeja GRA',
      'Yaba',
      'Surulere',
      'Gbagada',
      'Magodo',
      'Ogudu',
      'Festac'
    ]
  },
  {
    code: 'FC',
    name: 'Federal Capital Territory',
    phase: 2,
    launchOrder: 2,
    primaryCity: 'Abuja',
    areas: [
      'Maitama',
      'Asokoro',
      'Wuse 2',
      'Garki',
      'Gwarinpa',
      'Jabi',
      'Katampe Extension',
      'Lugbe',
      'Guzape',
      'Karsana'
    ]
  },
  {
    code: 'OY',
    name: 'Oyo',
    phase: 3,
    launchOrder: 3,
    primaryCity: 'Ibadan',
    areas: ['Bodija', 'Jericho', 'Ring Road', 'Dugbe', 'Akobo', 'Oluyole Estate', 'Agodi']
  },
  {
    code: 'IM',
    name: 'Imo',
    phase: 4,
    launchOrder: 4,
    primaryCity: 'Owerri',
    areas: ['New Owerri', 'Aladinma', 'Ikenegbu', 'GRA Owerri', 'MCC Road', 'Orji']
  },
  {
    code: 'AK',
    name: 'Akwa Ibom',
    phase: 5,
    launchOrder: 5,
    primaryCity: 'Uyo',
    areas: ['Ewet Housing Estate', 'Shelter Afrique', 'Osongama', 'Oron Road', 'Itam', 'Ibesikpo']
  }
];

/**
 * Expansion waves once the launch states are self-sustaining. Keep codes and
 * areas here so ops can switch a state live with a single DB status flip.
 */
export const EXPANSION_STATES: readonly NigerianStateSeed[] = [
  { code: 'RV', name: 'Rivers', phase: 6, launchOrder: 6, primaryCity: 'Port Harcourt', areas: ['GRA Phase 2', 'Peter Odili Road', 'Trans Amadi', 'Woji'] },
  { code: 'EN', name: 'Enugu', phase: 6, launchOrder: 7, primaryCity: 'Enugu', areas: ['Independence Layout', 'New Haven', 'GRA Enugu', 'Thinkers Corner'] },
  { code: 'KN', name: 'Kano', phase: 6, launchOrder: 8, primaryCity: 'Kano', areas: ['Nassarawa GRA', 'Bompai', 'Tarauni'] },
  { code: 'KD', name: 'Kaduna', phase: 6, launchOrder: 9, primaryCity: 'Kaduna', areas: ['Barnawa', 'Malali GRA', 'Ungwan Rimi'] },
  { code: 'OG', name: 'Ogun', phase: 6, launchOrder: 10, primaryCity: 'Abeokuta', areas: ['Ibara GRA', 'Oke Mosan', 'Laderin'] },
  { code: 'DE', name: 'Delta', phase: 7, launchOrder: 11, primaryCity: 'Asaba', areas: ['Okpanam Road', 'GRA Asaba', 'Infant Jesus'] },
  { code: 'AN', name: 'Anambra', phase: 7, launchOrder: 12, primaryCity: 'Awka', areas: ['Awka GRA', 'Amansea', 'Nkwelle'] },
  { code: 'AB', name: 'Abia', phase: 7, launchOrder: 13, primaryCity: 'Umuahia', areas: ['Umuahia GRA', 'Ahiaeke'] },
  { code: 'ED', name: 'Edo', phase: 7, launchOrder: 14, primaryCity: 'Benin City', areas: ['GRA Benin', 'Sapele Road', 'Airport Road'] },
  { code: 'CR', name: 'Cross River', phase: 8, launchOrder: 15, primaryCity: 'Calabar', areas: ['State Housing', 'Marian', 'Murtala Mohammed Way'] },
  { code: 'PL', name: 'Plateau', phase: 8, launchOrder: 16, primaryCity: 'Jos', areas: ['Rayfield', 'Jos GRA', 'Bukuru'] },
  { code: 'KW', name: 'Kwara', phase: 8, launchOrder: 17, primaryCity: 'Ilorin', areas: ['GRA Ilorin', 'Tanke', 'Fate Road'] },
  { code: 'OS', name: 'Osun', phase: 8, launchOrder: 18, primaryCity: 'Osogbo', areas: ['Oke Fia', 'Ring Road Osogbo'] },
  { code: 'ON', name: 'Ondo', phase: 9, launchOrder: 19, primaryCity: 'Akure', areas: ['Alagbaka', 'Oba Ile Road'] },
  { code: 'BO', name: 'Borno', phase: 9, launchOrder: 20, primaryCity: 'Maiduguri', areas: ['GRA Maiduguri'] },
  { code: 'BA', name: 'Bauchi', phase: 9, launchOrder: 21, primaryCity: 'Bauchi', areas: ['Bauchi GRA'] },
  { code: 'AD', name: 'Adamawa', phase: 9, launchOrder: 22, primaryCity: 'Yola', areas: ['Jimeta'] },
  { code: 'GO', name: 'Gombe', phase: 9, launchOrder: 23, primaryCity: 'Gombe', areas: ['Gombe GRA'] },
  { code: 'TA', name: 'Taraba', phase: 9, launchOrder: 24, primaryCity: 'Jalingo', areas: ['Jalingo GRA'] },
  { code: 'YO', name: 'Yobe', phase: 9, launchOrder: 25, primaryCity: 'Damaturu', areas: ['Damaturu GRA'] },
  { code: 'ZA', name: 'Zamfara', phase: 10, launchOrder: 26, primaryCity: 'Gusau', areas: ['Gusau GRA'] },
  { code: 'SO', name: 'Sokoto', phase: 10, launchOrder: 27, primaryCity: 'Sokoto', areas: ['Sokoto GRA'] },
  { code: 'KB', name: 'Kebbi', phase: 10, launchOrder: 28, primaryCity: 'Birnin Kebbi', areas: ['Birnin Kebbi GRA'] },
  { code: 'NI', name: 'Niger', phase: 10, launchOrder: 29, primaryCity: 'Minna', areas: ['Minna GRA', 'Tunga'] },
  { code: 'KO', name: 'Kogi', phase: 10, launchOrder: 30, primaryCity: 'Lokoja', areas: ['Lokoja GRA'] },
  { code: 'BE', name: 'Benue', phase: 10, launchOrder: 31, primaryCity: 'Makurdi', areas: ['Makurdi GRA'] },
  { code: 'NA', name: 'Nasarawa', phase: 11, launchOrder: 32, primaryCity: 'Lafia', areas: ['Lafia GRA'] },
  { code: 'EK', name: 'Ekiti', phase: 11, launchOrder: 33, primaryCity: 'Ado Ekiti', areas: ['Ado Ekiti GRA'] },
  { code: 'BY', name: 'Bayelsa', phase: 11, launchOrder: 34, primaryCity: 'Yenagoa', areas: ['Yenagoa GRA'] },
  { code: 'EB', name: 'Ebonyi', phase: 11, launchOrder: 35, primaryCity: 'Abakaliki', areas: ['Abakaliki GRA'] },
  { code: 'JT', name: 'Jigawa', phase: 11, launchOrder: 36, primaryCity: 'Dutse', areas: ['Dutse GRA'] },
  { code: 'KT', name: 'Katsina', phase: 11, launchOrder: 37, primaryCity: 'Katsina', areas: ['Katsina GRA'] }
];

export const ALL_STATES: readonly NigerianStateSeed[] = [...LAUNCH_STATES, ...EXPANSION_STATES];

export function findState(code: StateCode): NigerianStateSeed | undefined {
  return ALL_STATES.find((state) => state.code === code);
}

/**
 * Which states are exposed in search.
 *
 * @param mode             'phased' = only launch states up to the gate below,
 *                         'all'    = everything (used after national rollout).
 * @param lastLiveLaunchOrder  ops-controlled gate: 1 = Lagos only, 5 = all five
 *                         launch states live, 37 = national.
 */
export function liveStates(
  mode: 'phased' | 'all',
  lastLiveLaunchOrder = 1
): readonly NigerianStateSeed[] {
  if (mode === 'all') return ALL_STATES;
  return LAUNCH_STATES.filter((state) => state.launchOrder <= lastLiveLaunchOrder);
}

export function totalStates(): number {
  return ALL_STATES.length;
}
