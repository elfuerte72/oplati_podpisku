import { describe, expect, it } from 'vitest';

import { isPrivateAddress, isPrivateHostname } from './address.ts';

describe('внутренние адреса', () => {
  it('ловит петлю, частные сети, link-local и CGNAT', () => {
    const inside = [
      '127.0.0.1',
      '127.1.1.1',
      '0.0.0.0',
      '10.0.0.7',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ];
    for (const address of inside) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('внешние адреса пропускает', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('имена петли и локальной сети ловятся без DNS', () => {
    for (const host of ['localhost', 'LOCALHOST', 'printer.local', 'db.internal']) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
    expect(isPrivateHostname('example.com')).toBe(false);
  });

  it('IP в имени хоста ловится тем же правилом', () => {
    expect(isPrivateHostname('169.254.169.254')).toBe(true);
    expect(isPrivateHostname('[::1]')).toBe(true);
    expect(isPrivateHostname('93.184.216.34')).toBe(false);
  });
});
