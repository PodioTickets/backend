import { buildOrganizerNotificationRecipients } from '../notification-recipients.util';

describe('buildOrganizerNotificationRecipients', () => {
  it('envia para a organização E para o dono quando são diferentes', () => {
    expect(
      buildOrganizerNotificationRecipients([
        'contato@org.com',
        'dono@pessoal.com',
      ]),
    ).toEqual(['contato@org.com', 'dono@pessoal.com']);
  });

  it('não duplica quando os dois e-mails são iguais', () => {
    expect(
      buildOrganizerNotificationRecipients([
        'contato@org.com',
        'contato@org.com',
      ]),
    ).toEqual(['contato@org.com']);
  });

  it('não duplica quando diferem só na caixa ou em espaços das pontas', () => {
    expect(
      buildOrganizerNotificationRecipients([
        'Contato@Org.com',
        '  contato@org.com  ',
      ]),
    ).toEqual(['Contato@Org.com']);
  });

  it('ignora null, undefined e string vazia', () => {
    expect(
      buildOrganizerNotificationRecipients([
        null,
        '   ',
        'dono@pessoal.com',
        undefined,
      ]),
    ).toEqual(['dono@pessoal.com']);
  });

  it('sem nenhum e-mail utilizável devolve lista vazia', () => {
    expect(buildOrganizerNotificationRecipients([null, undefined, ''])).toEqual(
      [],
    );
  });
});
