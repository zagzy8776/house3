/**
 * Database seed.
 *
 * Safe to re-run: every write is an upsert keyed on a natural identifier, so
 * running it against an existing database will not duplicate states, areas or
 * fee policies.
 *
 *   npm run db:push && npm run db:seed
 */

import { PrismaClient } from '@prisma/client';
import { ALL_STATES, LAUNCH_STATES } from '../src/data/nigeria';
import { STATE_FEE_POLICIES, defaultFeePolicy } from '../src/data/feePolicies';

const prisma = new PrismaClient();

/** Only the first state starts live; the rest are gated until ops opens them. */
function initialStatus(launchOrder: number): 'LIVE' | 'SUPPLY_ONBOARDING' | 'PENDING' {
  if (launchOrder === 1) return 'LIVE';
  if (launchOrder <= LAUNCH_STATES.length) return 'SUPPLY_ONBOARDING';
  return 'PENDING';
}

async function seedGeography(): Promise<void> {
  for (const state of ALL_STATES) {
    await prisma.state.upsert({
      where: { code: state.code },
      update: {
        name: state.name,
        phase: state.phase,
        launchOrder: state.launchOrder,
        primaryCity: state.primaryCity
      },
      create: {
        code: state.code,
        name: state.name,
        phase: state.phase,
        launchOrder: state.launchOrder,
        primaryCity: state.primaryCity,
        status: initialStatus(state.launchOrder)
      }
    });

    // rank drives the search dropdown order: demand-weighted, not alphabetical.
    await Promise.all(
      state.areas.map((area, index) =>
        prisma.area.upsert({
          where: { stateCode_name: { stateCode: state.code, name: area } },
          update: { rank: (index + 1) * 10 },
          create: { stateCode: state.code, name: area, rank: (index + 1) * 10 }
        })
      )
    );
  }
}

async function seedFeePolicies(): Promise<void> {
  const globalPolicy = defaultFeePolicy();

  // A GLOBAL policy has no subject and no state, so use the fixed id as the key.
  await prisma.feePolicy.upsert({
    where: { id: globalPolicy.id },
    update: {
      rateBps: globalPolicy.rateBps,
      minFeeKobo: globalPolicy.minFeeKobo,
      maxFeeKobo: globalPolicy.maxFeeKobo,
      vatRateBps: globalPolicy.vatRateBps,
      roundingStepKobo: globalPolicy.roundingStepKobo,
      active: true
    },
    create: {
      id: globalPolicy.id,
      scope: 'GLOBAL',
      rateBps: globalPolicy.rateBps,
      minFeeKobo: globalPolicy.minFeeKobo,
      maxFeeKobo: globalPolicy.maxFeeKobo,
      vatRateBps: globalPolicy.vatRateBps,
      roundingStepKobo: globalPolicy.roundingStepKobo,
      active: true
    }
  });

  for (const policy of STATE_FEE_POLICIES) {
    const stateCode = policy.subjectId ?? null;
    await prisma.feePolicy.upsert({
      where: { id: policy.id },
      update: {
        rateBps: policy.rateBps,
        minFeeKobo: policy.minFeeKobo,
        maxFeeKobo: policy.maxFeeKobo,
        minNightlyFeeKobo: policy.minNightlyFeeKobo ?? null,
        vatRateBps: policy.vatRateBps,
        roundingStepKobo: policy.roundingStepKobo,
        active: true
      },
      create: {
        id: policy.id,
        scope: 'STATE',
        subjectId: policy.subjectId,
        stateCode,
        rateBps: policy.rateBps,
        minFeeKobo: policy.minFeeKobo,
        maxFeeKobo: policy.maxFeeKobo,
        minNightlyFeeKobo: policy.minNightlyFeeKobo ?? null,
        vatRateBps: policy.vatRateBps,
        roundingStepKobo: policy.roundingStepKobo,
        active: true
      }
    });
  }
}

async function main(): Promise<void> {
  await seedGeography();
  await seedFeePolicies();

  const [states, areas, policies] = await Promise.all([
    prisma.state.count(),
    prisma.area.count(),
    prisma.feePolicy.count()
  ]);

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${states} states (${LAUNCH_STATES.map((state) => state.code).join(', ')} are launch), ` +
      `${areas} areas, ${policies} fee policies.`
  );
  // eslint-disable-next-line no-console
  console.log(
    'Next: onboard partners with a signed supply agreement, then set their settlement ' +
      'account and PartnerChannel rows. Nothing is sellable until those exist.'
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
