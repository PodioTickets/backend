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
