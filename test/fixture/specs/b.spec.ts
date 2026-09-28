import { qase } from 'cypress-qase-reporter/dist/mocha';

describe('Root B', () => {
  context('[SETUP]', () => {
    it(qase(103, 'Shared title'), () => { cy.log('a'); });

    const providers = [{caseId: 300, name: 'p1'}, {caseId: 301, name: 'p2'}];
    providers.forEach((provider) => {
      qase(provider.caseId, it(`provision ${provider.name}`, () => { cy.log('b'); }));
    });
  });
});
