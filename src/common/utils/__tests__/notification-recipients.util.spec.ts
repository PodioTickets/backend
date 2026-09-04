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

  it('inclui TODOS os owners quando a organização tem mais de um', () => {
    expect(
      buildOrganizerNotificationRecipients([
        'contato@org.com',
        'dono1@pessoal.com',
        'dono2@pessoal.com',
      ]),
    ).toEqual(['contato@org.com', 'dono1@pessoal.com', 'dono2@pessoal.com']);
  });

  it('com vários owners, só o repetido é descartado', () => {
    // Caso real: o contato da org é o e-mail de um dos donos.
    expect(
      buildOrganizerNotificationRecipients([
        'contato@org.com',
        'contato@org.com',
        'dono2@pessoal.com',
      ]),
    ).toEqual(['contato@org.com', 'dono2@pessoal.com']);
  });

  it('preserva a ordem: organização primeiro, depois os owners', () => {
    expect(
      buildOrganizerNotificationRecipients([
        'contato@org.com',
        'dono1@pessoal.com',
      ])[0],
    ).toBe('contato@org.com');
  });

  it('sem nenhum e-mail utilizável devolve lista vazia', () => {
    expect(buildOrganizerNotificationRecipients([null, undefined, ''])).toEqual(
      [],
    );
  });
});
