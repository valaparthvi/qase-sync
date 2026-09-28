import { qase } from 'cypress-qase-reporter/dist/mocha';

describe('Root A', () => {
  context('[SETUP]', () => {
    qase(100, it('Setup namespace', () => { cy.log('1'); }));

    it('Get credential', () => { cy.log('2'); });

    it('Shared title', () => { cy.log('3'); });

    it('Ambiguous one', () => { cy.log('4'); });

    qase(107, it('Dup target', () => { cy.log('5'); }));

    qase(107, it('Dup target two', () => { cy.log('6'); }));

    qase(108, it('Renamed locally', () => { cy.log('7'); }));

    it('Prefixed on the Qase side', () => { cy.log('8'); });

    ['x', 'y'].forEach((n) => {
      qase(200, it(`loop ${n}`, () => { cy.log(n); }));
    });

    qase(SOME + 1, it('computed id', () => { cy.log('9'); }));
  });

  context('[TEARDOWN]', () => {
    qase(999, it('Delete cluster', () => { cy.log('10'); }));

    qase(998, it('Nowhere at all', () => { cy.log('11'); }));

    it('Common', () => { cy.log('12'); });
  });
});
