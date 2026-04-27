-- Snapshot completo da compra por registration (recibo imutável)
ALTER TABLE "Registration" ADD COLUMN "receiptSnapshot" JSONB;

-- Snapshot da pergunta no momento em que foi respondida
ALTER TABLE "QuestionAnswer" ADD COLUMN "questionSnapshot" JSONB;
