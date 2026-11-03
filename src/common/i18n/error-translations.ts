/**
 * Tradução das mensagens de erro do backend para o site PÚBLICO (en / es).
 *
 * Por quê aqui (e não em cada `throw`): as mensagens nascem em PT espalhadas por centenas
 * de `throw`; o `AllExceptionsFilter` é o ÚNICO ponto por onde todo erro passa. Traduzir
 * na saída mantém os services intactos e não custa request nem dependência.
 *
 * Contrato com o front: o `ApiClient` manda `Accept-Language` EXATAMENTE `en` / `es` /
 * `pt-BR` (o painel organizer/admin manda sempre `pt-BR`). Só esses valores exatos traduzem —
 * a lista do navegador (`en-US,en;q=0.9`, de fetch cru) cai em PT, senão quem está no site
 * em PT com navegador em inglês receberia erro em inglês.
 *
 * Fail-safe: mensagem fora do dicionário volta como está (PT). Escopo: fluxos do comprador
 * (login/cadastro/2FA/senha, checkout, cupom/voucher, pagamento, perfil, meus ingressos).
 *
 * `{0}`, `{1}`… = trecho variável (nome do ingresso, quantidades) copiado como veio.
 * 4º item opcional = versão pt-BR para mensagens que o back escreve em INGLÊS. NÃO dar
 * pt-BR a "Validation failed": o painel reconhece esse texto (`eventEditValidation.ts`).
 */
type Entry = [source: string, en: string, es: string, pt?: string];

const ENTRIES: Entry[] = [
  // ── Login / cadastro / sessão ────────────────────────────────────────────────
  ['Endereço de e-mail inválido', 'Invalid email address', 'Dirección de correo electrónico inválida'],
  ['Invalid credentials', 'Invalid email or password', 'Correo o contraseña incorrectos', 'Credenciais inválidas'],
  ['Credenciais inválidas', 'Invalid email or password', 'Correo o contraseña incorrectos'],
  ['Muitas tentativas de login. Tente novamente em alguns minutos.', 'Too many login attempts. Please try again in a few minutes.', 'Demasiados intentos de inicio de sesión. Inténtalo de nuevo en unos minutos.'],
  ['Terms of purchase and privacy policy must be accepted', 'You must accept the terms of purchase and the privacy policy', 'Debes aceptar los términos de compra y la política de privacidad', 'É preciso aceitar os termos de compra e a política de privacidade'],
  ['Já existe um usuário com este e-mail', 'A user with this email already exists', 'Ya existe un usuario con este correo electrónico'],
  ['User with this document number already exists', 'A user with this document already exists', 'Ya existe un usuario con este documento', 'Já existe um usuário com este documento'],
  ['Usuário já existe', 'User already exists', 'El usuario ya existe'],
  ['Erro ao processar autenticação', 'Could not process authentication', 'Error al procesar la autenticación'],
  ['Token MFA inválido ou expirado.', 'Invalid or expired verification. Please log in again.', 'Verificación inválida o expirada. Inicia sesión de nuevo.'],
  ['Token MFA inválido.', 'Invalid verification. Please log in again.', 'Verificación inválida. Inicia sesión de nuevo.'],
  ['Usuário não encontrado.', 'User not found.', 'Usuario no encontrado.'],
  ['Usuário não encontrado', 'User not found', 'Usuario no encontrado'],
  ['Usuário não encontrado ou inativo', 'User not found or inactive', 'Usuario no encontrado o inactivo'],
  ['Token inválido', 'Invalid token', 'Token inválido'],
  ['Token inválido ou expirado', 'Invalid or expired link', 'Enlace inválido o expirado'],
  ['Sessão expirada — faça login novamente', 'Session expired — please log in again', 'Sesión expirada — inicia sesión de nuevo'],
  ['MFA não concluído', 'Two-step verification not completed', 'Verificación en dos pasos no completada'],
  ['Email or CPF is required', 'Email or CPF is required', 'El correo o el CPF es obligatorio', 'Informe o e-mail ou CPF'],
  ['Senha é obrigatória', 'Password is required', 'La contraseña es obligatoria'],
  ['Verificação de segurança inválida.', 'Security check failed.', 'Verificación de seguridad inválida.'],
  ['Esta conta foi excluída e não pode ser recuperada.', 'This account was deleted and cannot be recovered.', 'Esta cuenta fue eliminada y no se puede recuperar.'],
  ['Falha ao autenticar com o Google', 'Could not sign in with Google', 'No se pudo iniciar sesión con Google'],
  ['Falha na autenticação com Google', 'Could not sign in with Google', 'No se pudo iniciar sesión con Google'],
  ['E-mail da conta Google não verificado', 'Your Google account email is not verified', 'El correo de tu cuenta de Google no está verificado'],

  // ── Códigos por e-mail / 2FA ─────────────────────────────────────────────────
  ['Código inválido ou expirado', 'Invalid or expired code', 'Código inválido o expirado'],
  ['Código já foi utilizado', 'This code has already been used', 'Este código ya fue utilizado'],
  ['Código expirado', 'Code expired', 'Código expirado'],
  ['Código inválido', 'Invalid code', 'Código inválido'],
  ['Código incorreto ou expirado.', 'Incorrect or expired code.', 'Código incorrecto o expirado.'],
  ['Muitas tentativas. Solicite um novo código', 'Too many attempts. Request a new code', 'Demasiados intentos. Solicita un código nuevo'],
  ['Muitas tentativas inválidas. Solicite um novo código', 'Too many invalid attempts. Request a new code', 'Demasiados intentos inválidos. Solicita un código nuevo'],
  ['Muitas tentativas incorretas. Solicite um novo código.', 'Too many incorrect attempts. Request a new code.', 'Demasiados intentos incorrectos. Solicita un código nuevo.'],
  ['Aguarde 1 minuto antes de solicitar um novo código.', 'Please wait 1 minute before requesting a new code.', 'Espera 1 minuto antes de solicitar un código nuevo.'],
  ['Falha ao enviar o e-mail. Tente novamente.', 'Could not send the email. Please try again.', 'No se pudo enviar el correo. Inténtalo de nuevo.'],
  ['O código deve conter exatamente 6 dígitos numéricos', 'The code must have exactly 6 digits', 'El código debe tener exactamente 6 dígitos'],

  // ── Senha / e-mail da conta ──────────────────────────────────────────────────
  ['A senha deve ter no mínimo 8 caracteres', 'Password must be at least 8 characters', 'La contraseña debe tener al menos 8 caracteres'],
  ['A senha deve conter pelo menos uma letra maiúscula, uma minúscula e um número', 'Password must contain at least one uppercase letter, one lowercase letter and one number', 'La contraseña debe contener al menos una mayúscula, una minúscula y un número'],
  ['Password must be at least 8 characters long and contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*?&)', 'Password must be at least 8 characters long and contain at least one lowercase letter, one uppercase letter, one number, and one special character (@$!%*?&)', 'La contraseña debe tener al menos 8 caracteres y contener una minúscula, una mayúscula, un número y un carácter especial (@$!%*?&)', 'A senha deve ter no mínimo 8 caracteres e conter uma letra minúscula, uma maiúscula, um número e um caractere especial (@$!%*?&)'],
  ['Password is too common. Please choose a more secure password.', 'Password is too common. Please choose a more secure password.', 'La contraseña es demasiado común. Elige una más segura.', 'Senha muito comum. Escolha uma senha mais segura.'],
  ['Password contains sequential characters. Please choose a more secure password.', 'Password contains sequential characters. Please choose a more secure password.', 'La contraseña contiene caracteres secuenciales. Elige una más segura.', 'A senha contém caracteres em sequência. Escolha uma senha mais segura.'],
  ['A nova senha não pode ser igual à senha atual', 'The new password cannot be the same as the current one', 'La nueva contraseña no puede ser igual a la actual'],
  ['Senha atual é obrigatória para trocar a senha', 'Your current password is required to change it', 'La contraseña actual es obligatoria para cambiarla'],
  ['Senha atual incorreta', 'Current password is incorrect', 'Contraseña actual incorrecta'],
  ['Senha incorreta', 'Incorrect password', 'Contraseña incorrecta'],
  ['Conta sem senha local — use a autenticação Google para gerenciar o e-mail', 'This account has no password — use Google sign-in to manage your email', 'Esta cuenta no tiene contraseña — usa el inicio de sesión con Google para gestionar el correo'],
  ['O novo e-mail deve ser diferente do atual', 'The new email must be different from the current one', 'El nuevo correo debe ser diferente del actual'],
  ['Este e-mail já está em uso', 'This email is already in use', 'Este correo electrónico ya está en uso'],
  ['Informe o motivo da exclusão.', 'Please tell us why you are deleting your account.', 'Indica el motivo de la eliminación.'],

  // ── Dados pessoais / usuários vinculados ─────────────────────────────────────
  ['Usuário deve ter pelo menos 18 anos', 'You must be at least 18 years old', 'Debes tener al menos 18 años'],
  ['CPF inválido', 'Invalid CPF', 'CPF inválido'],
  ['Telefone deve conter apenas dígitos (10 ou 11)', 'Phone must contain only digits (10 or 11)', 'El teléfono debe contener solo dígitos (10 u 11)'],
  ['Telefone de emergência deve conter apenas dígitos (10 ou 11)', 'Emergency phone must contain only digits (10 or 11)', 'El teléfono de emergencia debe contener solo dígitos (10 u 11)'],
  ['Documento contém caracteres inválidos', 'Document contains invalid characters', 'El documento contiene caracteres inválidos'],
  ['Já existe um usuário com este CPF', 'A user with this CPF already exists', 'Ya existe un usuario con este CPF'],
  ['Data de nascimento não pode ser futura', 'Date of birth cannot be in the future', 'La fecha de nacimiento no puede ser futura'],
  ['Não é possível adicionar você mesmo como usuário vinculado', 'You cannot add yourself as a linked user', 'No puedes agregarte a ti mismo como usuario vinculado'],
  ['Usuário vinculado não encontrado', 'Linked user not found', 'Usuario vinculado no encontrado'],
  ['Sem permissão para atualizar este usuário', 'You are not allowed to update this user', 'No tienes permiso para actualizar este usuario'],
  ['Arquivo não fornecido', 'No file provided', 'No se envió ningún archivo'],
  ['Erro ao fazer upload do avatar: {0}', 'Could not upload the photo: {0}', 'Error al subir la foto: {0}'],
  ['documentNumber inválido', 'Invalid document', 'Documento inválido', 'Documento inválido'],
  ['country inválido', 'Invalid country', 'País inválido', 'País inválido'],
  ['nationality inválido', 'Invalid nationality', 'Nacionalidad inválida', 'Nacionalidade inválida'],
  ['E-mail é obrigatório', 'Email is required', 'El correo electrónico es obligatorio'],
  ['E-mail inválido', 'Invalid email', 'Correo electrónico inválido'],

  // ── Checkout: reserva / ingressos / participantes ────────────────────────────
  ['Muitas tentativas. Aguarde alguns segundos e tente novamente.', 'Too many attempts. Wait a few seconds and try again.', 'Demasiados intentos. Espera unos segundos e inténtalo de nuevo.'],
  ['Você já possui 3 pedidos pendentes. Conclua ou cancele-os antes de reservar um novo.', 'You already have 3 pending orders. Complete or cancel them before making a new reservation.', 'Ya tienes 3 pedidos pendientes. Complétalos o cancélalos antes de reservar uno nuevo.'],
  ['Limite de {0} ingressos por pedido excedido. Total solicitado: {1}.', 'Limit of {0} tickets per order exceeded. Requested: {1}.', 'Se superó el límite de {0} entradas por pedido. Solicitadas: {1}.'],
  ['Evento não encontrado', 'Event not found', 'Evento no encontrado'],
  ['Event not found', 'Event not found', 'Evento no encontrado', 'Evento não encontrado'],
  ['Evento não está disponível para compra', 'This event is not available for purchase', 'Este evento no está disponible para la compra'],
  ['Inscrições ainda não abertas para este evento', 'Registration for this event is not open yet', 'Las inscripciones para este evento aún no están abiertas'],
  ['Período de inscrição encerrado', 'Registration period has ended', 'El período de inscripción terminó'],
  ['Ingresso {0} não encontrado ou inativo', 'Ticket {0} not found or inactive', 'Entrada {0} no encontrada o inactiva'],
  ['Ingresso {0} não pertence a este evento', 'Ticket {0} does not belong to this event', 'La entrada {0} no pertenece a este evento'],
  ['Ingresso não encontrado', 'Ticket not found', 'Entrada no encontrada'],
  ['Nenhum lote encontrado para o ingresso "{0}"', 'No batch found for the ticket "{0}"', 'No se encontró ningún lote para la entrada "{0}"'],
  ['O lote enviado não é o lote ativo para "{0}". Use o lote {1}.', 'This is not the active batch for "{0}". Please reload the page.', 'Este no es el lote activo de "{0}". Recarga la página.'],
  ['Lote ainda não iniciado para o ingresso "{0}"', 'Sales for the ticket "{0}" have not started yet', 'La venta de la entrada "{0}" aún no comenzó'],
  ['Sem vagas disponíveis para o ingresso "{0}". Lote esgotado.', 'No spots left for the ticket "{0}". Sold out.', 'No quedan cupos para la entrada "{0}". Agotado.'],
  ['Evento esgotado. Não há vagas suficientes para concluir a reserva.', 'Event sold out. There are not enough spots to complete the reservation.', 'Evento agotado. No hay cupos suficientes para completar la reserva.'],
  ['Selecione ao menos um ingresso.', 'Select at least one ticket.', 'Selecciona al menos una entrada.'],
  ['Informe os dados de exatamente um participante por ingresso.', 'Enter the details of exactly one participant per ticket.', 'Ingresa los datos de exactamente un participante por entrada.'],
  ['Número de participantes ({0}) excede os ingressos reservados ({1}).', 'Number of participants ({0}) exceeds the reserved tickets ({1}).', 'El número de participantes ({0}) supera las entradas reservadas ({1}).'],
  ['O ingresso "{0}" exige no mínimo {1} participantes.', 'The ticket "{0}" requires at least {1} participants.', 'La entrada "{0}" requiere al menos {1} participantes.'],
  ['Este evento permite apenas um ingresso por CPF. Use um documento diferente em cada ingresso do pedido.', 'This event allows only one ticket per CPF. Use a different document for each ticket in the order.', 'Este evento permite solo una entrada por CPF. Usa un documento diferente en cada entrada del pedido.'],
  ['Este evento permite apenas um ingresso por CPF, e este documento já tem inscrição neste evento.', 'This event allows only one ticket per CPF, and this document is already registered for it.', 'Este evento permite solo una entrada por CPF, y este documento ya está inscrito en él.'],
  ['E-mail "{0}" não pertence a nenhum participante deste pedido.', 'The email "{0}" does not belong to any participant in this order.', 'El correo "{0}" no pertenece a ningún participante de este pedido.'],
  ['Preencha os dados de todos os {0} participante(s) antes de pagar ({1} preenchido(s)).', 'Fill in the details of all {0} participant(s) before paying ({1} completed).', 'Completa los datos de los {0} participante(s) antes de pagar ({1} completado(s)).'],
  ['Dados dos participantes são obrigatórios', 'Participant details are required', 'Los datos de los participantes son obligatorios'],
  ['Resposta inválida para "{0}": {1}. Opções válidas: {2}', 'Invalid answer for "{0}": {1}. Valid options: {2}', 'Respuesta inválida para "{0}": {1}. Opciones válidas: {2}'],
  ['Terms and rules must be accepted', 'You must accept the terms and rules', 'Debes aceptar los términos y el reglamento', 'É preciso aceitar os termos e o regulamento'],
  ['Event is not available for registration', 'This event is not available for registration', 'Este evento no está disponible para inscripción', 'Evento não disponível para inscrição'],
  ['Registration period has ended', 'Registration period has ended', 'El período de inscripción terminó', 'Período de inscrição encerrado'],
  ['Event has already occurred', 'This event has already taken place', 'Este evento ya se realizó', 'Este evento já aconteceu'],

  // ── Checkout: produtos ───────────────────────────────────────────────────────
  ['Produto {0} não encontrado', 'Product {0} not found', 'Producto {0} no encontrado'],
  ['Produto "{0}" não pertence ao evento deste pedido.', 'The product "{0}" does not belong to this order\'s event.', 'El producto "{0}" no pertenece al evento de este pedido.'],
  ['Variação selecionada não encontrada para "{0}". Selecione uma opção válida.', 'Selected option not found for "{0}". Please choose a valid option.', 'No se encontró la opción seleccionada para "{0}". Elige una opción válida.'],
  ['Estoque insuficiente para "{0}". Reduza a quantidade ou escolha outra opção.', 'Not enough stock for "{0}". Reduce the quantity or choose another option.', 'Stock insuficiente para "{0}". Reduce la cantidad o elige otra opción.'],
  ['"{0}" ({1}) está esgotado', '"{0}" ({1}) is sold out', '"{0}" ({1}) está agotado'],

  // ── Checkout: cupom / voucher ────────────────────────────────────────────────
  ['Não é possível usar cupom e voucher ao mesmo tempo', 'You cannot use a coupon and a voucher at the same time', 'No puedes usar un cupón y un voucher al mismo tiempo'],
  ['Cannot use both coupon and voucher at the same time', 'You cannot use a coupon and a voucher at the same time', 'No puedes usar un cupón y un voucher al mismo tiempo', 'Não é possível usar cupom e voucher ao mesmo tempo'],
  ['Cupom não encontrado ou inválido', 'Coupon not found or invalid', 'Cupón no encontrado o inválido'],
  ['Cupom não encontrado', 'Coupon not found', 'Cupón no encontrado'],
  ['Cupom expirado', 'Coupon expired', 'Cupón expirado'],
  ['Cupom esgotado', 'Coupon sold out', 'Cupón agotado'],
  ['Cupom esgotado. Prossiga sem desconto ou escolha outro cupom.', 'Coupon sold out. Continue without a discount or choose another coupon.', 'Cupón agotado. Continúa sin descuento o elige otro cupón.'],
  ['Cupom não está ativo', 'Coupon is not active', 'El cupón no está activo'],
  ['Cupom não é válido para este usuário', 'This coupon is not valid for this user', 'Este cupón no es válido para este usuario'],
  ['Cupom não aplicável: nenhum participante elegível', 'Coupon not applicable: no eligible participant', 'Cupón no aplicable: ningún participante elegible'],
  ['Cupom não se aplica às modalidades selecionadas', 'This coupon does not apply to the selected sports', 'Este cupón no se aplica a las modalidades seleccionadas'],
  ['Quantidade de modalidades fora da faixa exigida por este cupom', 'The number of sports is outside the range required by this coupon', 'La cantidad de modalidades está fuera del rango exigido por este cupón'],
  ['Valor mínimo do pedido para este cupom: R$ {0}', 'Minimum order value for this coupon: R$ {0}', 'Valor mínimo del pedido para este cupón: R$ {0}'],
  ['Minimum cart value of {0} is required for this coupon', 'Minimum order value of {0} is required for this coupon', 'Se requiere un valor mínimo de {0} para este cupón', 'Valor mínimo do pedido para este cupom: {0}'],
  ['Documento do usuário é obrigatório para este cupom', 'Your document is required for this coupon', 'Tu documento es obligatorio para este cupón'],
  ['Voucher não encontrado ou inválido', 'Voucher not found or invalid', 'Voucher no encontrado o inválido'],
  ['Voucher not found', 'Voucher not found', 'Voucher no encontrado', 'Voucher não encontrado'],
  ['Voucher expirado', 'Voucher expired', 'Voucher expirado'],
  ['Este voucher já foi utilizado', 'This voucher has already been used', 'Este voucher ya fue utilizado'],
  ['Este voucher já está sendo usado em outro pedido.', 'This voucher is already being used in another order.', 'Este voucher ya se está usando en otro pedido.'],
  ['Este voucher já foi utilizado ou está sendo usado em outro pedido.', 'This voucher has already been used or is being used in another order.', 'Este voucher ya fue utilizado o se está usando en otro pedido.'],
  ['Voucher não aplicável: nenhum participante elegível', 'Voucher not applicable: no eligible participant', 'Voucher no aplicable: ningún participante elegible'],
  ['Voucher não aplicável aos ingressos do pedido', 'Voucher does not apply to the tickets in this order', 'El voucher no se aplica a las entradas del pedido'],
  ['Documento do usuário é obrigatório para este voucher', 'Your document is required for this voucher', 'Tu documento es obligatorio para este voucher'],
  ['Voucher is not valid for this event', 'This voucher is not valid for this event', 'Este voucher no es válido para este evento', 'Voucher não é válido para este evento'],
  ['Voucher is not active', 'This voucher is not active', 'Este voucher no está activo', 'Voucher não está ativo'],
  ['Voucher has already been used', 'This voucher has already been used', 'Este voucher ya fue utilizado', 'Este voucher já foi utilizado'],
  ['Voucher has expired', 'This voucher has expired', 'Este voucher expiró', 'Voucher expirado'],
  ['Voucher is not valid for this user', 'This voucher is not valid for this user', 'Este voucher no es válido para este usuario', 'Voucher não é válido para este usuário'],
  ['Voucher does not apply to selected modalities', 'This voucher does not apply to the selected sports', 'Este voucher no se aplica a las modalidades seleccionadas', 'Voucher não se aplica às modalidades selecionadas'],

  // ── Pedido / pagamento ───────────────────────────────────────────────────────
  ['Pedido não encontrado', 'Order not found', 'Pedido no encontrado'],
  ['Order not found', 'Order not found', 'Pedido no encontrado', 'Pedido não encontrado'],
  ['Você não é o dono deste pedido.', 'This order does not belong to you.', 'Este pedido no te pertenece.'],
  ['Este pedido não está mais pendente.', 'This order is no longer pending.', 'Este pedido ya no está pendiente.'],
  ['Pedido não está mais pendente', 'Order is no longer pending', 'El pedido ya no está pendiente'],
  ['Pedido não está mais pendente ou expirou', 'Order is no longer pending or has expired', 'El pedido ya no está pendiente o expiró'],
  ['Pedido não está mais pendente e não pode ser alterado', 'Order is no longer pending and cannot be changed', 'El pedido ya no está pendiente y no se puede modificar'],
  ['Já existe um pagamento em processamento para esta chave — aguarde a resposta.', 'A payment is already being processed — please wait for the response.', 'Ya hay un pago en proceso — espera la respuesta.'],
  ['Endereço de cobrança é obrigatório', 'Billing address is required', 'La dirección de facturación es obligatoria'],
  ['Este evento não aceita esta forma de pagamento', 'This event does not accept this payment method', 'Este evento no acepta este medio de pago'],
  ['Card data or card token is required', 'Card details are required', 'Los datos de la tarjeta son obligatorios', 'Os dados do cartão são obrigatórios'],
  ['Card data is required for debit card payments', 'Card details are required for debit card payments', 'Los datos de la tarjeta son obligatorios para pagos con débito', 'Os dados do cartão são obrigatórios para pagamento no débito'],
  ['Security code must be 3 or 4 digits', 'Security code must be 3 or 4 digits', 'El código de seguridad debe tener 3 o 4 dígitos', 'O código de segurança deve ter 3 ou 4 dígitos'],
  ['Pagamento recusado. Verifique os dados e tente novamente.', 'Payment declined. Check your details and try again.', 'Pago rechazado. Verifica los datos e inténtalo de nuevo.'],
  ['Pagamento negado', 'Payment declined', 'Pago rechazado'],
  ['Pagamento não autorizado. Verifique os dados do cartão e tente novamente.', 'Payment not authorized. Check your card details and try again.', 'Pago no autorizado. Verifica los datos de la tarjeta e inténtalo de nuevo.'],
  ['Não foi possível confirmar o pagamento. Nenhum valor foi cobrado — tente novamente.', 'We could not confirm the payment. You were not charged — please try again.', 'No pudimos confirmar el pago. No se realizó ningún cargo — inténtalo de nuevo.'],
  ['Cartão cancelado ou bloqueado. Entre em contato com seu banco ou use outro cartão.', 'Card canceled or blocked. Contact your bank or use another card.', 'Tarjeta cancelada o bloqueada. Contacta a tu banco o usa otra tarjeta.'],
  ['Saldo insuficiente ou limite excedido. Verifique seu limite ou use outro cartão.', 'Insufficient funds or limit exceeded. Check your limit or use another card.', 'Saldo insuficiente o límite excedido. Verifica tu límite o usa otra tarjeta.'],
  ['Transação não permitida para este cartão. Entre em contato com seu banco.', 'Transaction not allowed for this card. Contact your bank.', 'Transacción no permitida para esta tarjeta. Contacta a tu banco.'],
  ['Cartão bloqueado. Entre em contato com seu banco.', 'Card blocked. Contact your bank.', 'Tarjeta bloqueada. Contacta a tu banco.'],
  ['Erro no processamento do cartão. Tente novamente ou use outro cartão.', 'Card processing error. Try again or use another card.', 'Error al procesar la tarjeta. Inténtalo de nuevo o usa otra tarjeta.'],
  ['Erro na validação do cartão. Verifique os dados e tente novamente.', 'Card validation error. Check your details and try again.', 'Error al validar la tarjeta. Verifica los datos e inténtalo de nuevo.'],
  ['Falha no processamento. Tente novamente em alguns instantes.', 'Processing failed. Please try again in a moment.', 'Falló el procesamiento. Inténtalo de nuevo en unos instantes.'],
  ['Timeout na comunicação. Tente novamente.', 'Connection timed out. Please try again.', 'Se agotó el tiempo de conexión. Inténtalo de nuevo.'],
  ['Payment not found', 'Payment not found', 'Pago no encontrado', 'Pagamento não encontrado'],
  ['Payment not found for this registration', 'Payment not found for this registration', 'Pago no encontrado para esta inscripción', 'Pagamento não encontrado para esta inscrição'],
  ['No payment has been processed for this order yet', 'No payment has been processed for this order yet', 'Aún no se procesó ningún pago para este pedido', 'Nenhum pagamento foi processado para este pedido ainda'],
  ['Pedido não encontrado para esta inscrição', 'Order not found for this registration', 'Pedido no encontrado para esta inscripción'],
  ['Acesso negado — você não tem permissão para baixar este comprovante', 'Access denied — you are not allowed to download this receipt', 'Acceso denegado — no tienes permiso para descargar este comprobante'],

  // ── Meus ingressos / inscrição ───────────────────────────────────────────────
  ['Inscrição não encontrada', 'Registration not found', 'Inscripción no encontrada'],
  ['Registration not found', 'Registration not found', 'Inscripción no encontrada', 'Inscrição não encontrada'],
  ['Acesso negado', 'Access denied', 'Acceso denegado'],
  ['Access denied', 'Access denied', 'Acceso denegado', 'Acesso negado'],
  ['Acesso negado — você só pode visualizar suas próprias inscrições', 'Access denied — you can only view your own registrations', 'Acceso denegado — solo puedes ver tus propias inscripciones'],
  ['Acesso negado — você não tem permissão para reenviar este pedido', 'Access denied — you are not allowed to resend this order', 'Acceso denegado — no tienes permiso para reenviar este pedido'],
  ['O pedido não possui ingressos válidos para reenvio', 'This order has no valid tickets to resend', 'El pedido no tiene entradas válidas para reenviar'],
  ['Não foi possível gerar os anexos do pedido. Tente novamente.', 'Could not generate the order attachments. Please try again.', 'No se pudieron generar los adjuntos del pedido. Inténtalo de nuevo.'],
  ['Inscrição já cancelada', 'Registration already canceled', 'Inscripción ya cancelada'],
  ['Não é possível cancelar uma inscrição paga', 'A paid registration cannot be canceled', 'No se puede cancelar una inscripción pagada'],
  ['Só é possível alterar variação em inscrições confirmadas', 'You can only change the option on confirmed registrations', 'Solo puedes cambiar la opción en inscripciones confirmadas'],
  ['Só é possível editar inscrições confirmadas', 'Only confirmed registrations can be edited', 'Solo se pueden editar inscripciones confirmadas'],
  ['Produto não encontrado', 'Product not found', 'Producto no encontrado'],
  ['Product not found', 'Product not found', 'Producto no encontrado', 'Produto não encontrado'],
  ['Alteração de variação permitida apenas para produtos inclusos no ingresso', 'You can only change the option of products included in the ticket', 'Solo puedes cambiar la opción de productos incluidos en la entrada'],
  ['Este produto não permite alteração de variação', 'This product does not allow changing the option', 'Este producto no permite cambiar la opción'],
  ['A variação deste produto já foi alterada anteriormente', 'The option for this product has already been changed', 'La opción de este producto ya fue cambiada'],
  ['Produto não está vinculado ao ingresso desta inscrição', 'This product is not linked to this registration\'s ticket', 'Este producto no está vinculado a la entrada de esta inscripción'],
  ['Prazo para alteração de variação encerrado', 'The deadline to change the option has passed', 'El plazo para cambiar la opción terminó'],
  ['Evento da inscrição não encontrado', 'Registration event not found', 'Evento de la inscripción no encontrado'],
  ['Variação inválida para este produto', 'Invalid option for this product', 'Opción inválida para este producto'],
  ['A variação escolhida está esgotada', 'The selected option is sold out', 'La opción elegida está agotada'],

  // ── Genéricos ────────────────────────────────────────────────────────────────
  ['Validation failed', 'Validation failed', 'Error de validación'],
  ['Origem da requisição não permitida', 'Request origin not allowed', 'Origen de la solicitud no permitido'],
  ['Too many requests. Please try again later.', 'Too many requests. Please try again later.', 'Demasiadas solicitudes. Inténtalo de nuevo más tarde.', 'Muitas requisições. Tente novamente mais tarde.'],
  ['ThrottlerException: Too Many Requests', 'Too many requests. Please wait a moment and try again.', 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.', 'Muitas requisições. Aguarde um momento e tente novamente.'],
  ['Erro interno do servidor', 'Internal server error', 'Error interno del servidor'],
];

export type ErrorLocale = 'pt-BR' | 'en' | 'es';
type Target = { en: string; es: string; pt?: string };
type Pattern = { re: RegExp; t: Target };

// Montado 1x no boot. Exatas → Map (O(1)); com `{n}` → regex ancorada (poucas dezenas).
const EXACT = new Map<string, Target>();
const PATTERNS: Pattern[] = [];
for (const [source, en, es, pt] of ENTRIES) {
  const t: Target = { en, es, pt };
  if (/\{\d+\}/.test(source)) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d+)\\\}/g, '(?<g$1>.+?)');
    PATTERNS.push({ re: new RegExp(`^${escaped}$`, 's'), t });
  } else {
    EXACT.set(source, t);
  }
}

/** Só `en` / `es` / `pt-BR` EXATOS (o que o `ApiClient` manda); lista do navegador → pt-BR. */
export function parseErrorLocale(header: string | string[] | undefined): ErrorLocale {
  const v = (Array.isArray(header) ? header[0] : header ?? '').trim().toLowerCase();
  if (v === 'en') return 'en';
  if (v === 'es') return 'es';
  return 'pt-BR';
}

function fill(template: string, groups: Record<string, string> | undefined): string {
  return template.replace(/\{(\d+)\}/g, (m, n) => groups?.[`g${n}`] ?? m);
}

/** Traduz a mensagem; fora do dicionário (ou sem versão pt-BR) devolve a original. */
export function translateErrorMessage(message: string, locale: ErrorLocale): string {
  if (typeof message !== 'string' || !message) return message;
  const key = locale === 'pt-BR' ? 'pt' : locale;
  const exact = EXACT.get(message);
  if (exact) return exact[key] ?? message;
  for (const p of PATTERNS) {
    const m = p.re.exec(message);
    if (m) {
      const tpl = p.t[key];
      return tpl ? fill(tpl, m.groups) : message;
    }
  }
  return message;
}

/** `errors` do ValidationPipe / `details`: strings ou objetos `{ message }` (1 nível). */
export function translateErrorList(list: unknown, locale: ErrorLocale): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((item) => {
    if (typeof item === 'string') return translateErrorMessage(item, locale);
    if (item && typeof item === 'object' && typeof (item as any).message === 'string') {
      return { ...(item as any), message: translateErrorMessage((item as any).message, locale) };
    }
    return item;
  });
}
