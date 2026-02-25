-- Esta migration é uma correção para garantir que os índices existam
-- mas não tenta criá-los se já existirem (evita erros de duplicação)

-- Verificar e criar Event_slug_key se não existir
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename = 'Event' 
    AND indexname = 'Event_slug_key'
  ) THEN
    CREATE UNIQUE INDEX "Event_slug_key" ON "Event"("slug");
  END IF;
END $$;

-- Verificar e criar User_googleId_key se não existir
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename = 'User' 
    AND indexname = 'User_googleId_key'
  ) THEN
    CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
  END IF;
END $$;
