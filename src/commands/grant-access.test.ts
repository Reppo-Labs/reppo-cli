import { describe, it, expect } from 'vitest';
import { accessFns } from './grant-access.js';

describe('accessFns', () => {
  it('maps "reppo" to the REPPO access method + fee getter', () => {
    expect(accessFns('reppo')).toEqual({
      access: 'accessSubnetWithREPPOFee',
      feeGetter: 'getAccessFeeREPPO',
    });
  });

  it('maps "primary" to the primary-token access method + fee getter', () => {
    expect(accessFns('primary')).toEqual({
      access: 'accessSubnetWithPrimaryTokenFee',
      feeGetter: 'getAccessFeePrimaryToken',
    });
  });
});
