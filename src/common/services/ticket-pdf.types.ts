export interface TicketPdfProduct {
  name: string;
  price: number;
  variationName?: string;
  imageUrl?: string;
  isIncluded: boolean;
}

export interface TicketPdfRegistration {
  index: number;
  qrCode: string;
  participantName: string;
  ticketName: string;
  email?: string;
  cpf?: string;
  /**
   * País do participante (ex.: "BR", "Brasil", "US", "PT"). Usado para decidir
   * o label do documento ("CPF" para brasileiros, "Documento" caso contrário)
   * e se aplica formatação de CPF (xxx.xxx.xxx-xx) ou exibe o valor cru.
   * Quando ausente/nulo, assume brasileiro (compatibilidade com dados antigos).
   */
  country?: string | null;
  /**
   * Tipo do documento (CPF | PASSPORT). Sinal autoritativo de nacionalidade
   * quando o campo `country` chega nulo (cadastros pre-migration). PASSPORT
   * explicito força o template a tratar o usuario como estrangeiro.
   */
  documentType?: 'CPF' | 'PASSPORT' | null;
  dateOfBirth?: Date | string | null;
  phone?: string;
  gender?: string;
  questionAnswers: Array<{ question: string; answer: string }>;
  products: TicketPdfProduct[];
}

export interface TicketPdfData {
  orderId: string;
  orderNumber: string;
  issuedAt: Date;
  event: {
    name: string;
    date: Date | string;
    organization: string;
    location: string;
    participantCount: number;
  };
  registrations: TicketPdfRegistration[];
}

export interface TicketPdfRegistrationWithQr extends TicketPdfRegistration {
  qrDataUrl: string;
}

export interface TicketPdfTemplateData extends Omit<TicketPdfData, 'registrations'> {
  registrations: TicketPdfRegistrationWithQr[];
}
