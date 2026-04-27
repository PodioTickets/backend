-- Normaliza campo state de nome completo para sigla UF (ex: "São Paulo" → "SP")
UPDATE "Event"
SET state = CASE
  WHEN state = 'Acre'                 THEN 'AC'
  WHEN state = 'Alagoas'              THEN 'AL'
  WHEN state = 'Amapá'               THEN 'AP'
  WHEN state = 'Amazonas'             THEN 'AM'
  WHEN state = 'Bahia'                THEN 'BA'
  WHEN state = 'Ceará'               THEN 'CE'
  WHEN state = 'Distrito Federal'     THEN 'DF'
  WHEN state = 'Espírito Santo'      THEN 'ES'
  WHEN state = 'Goiás'              THEN 'GO'
  WHEN state = 'Maranhão'           THEN 'MA'
  WHEN state = 'Mato Grosso'         THEN 'MT'
  WHEN state = 'Mato Grosso do Sul'  THEN 'MS'
  WHEN state = 'Minas Gerais'        THEN 'MG'
  WHEN state = 'Pará'               THEN 'PA'
  WHEN state = 'Paraíba'            THEN 'PB'
  WHEN state = 'Paraná'             THEN 'PR'
  WHEN state = 'Pernambuco'          THEN 'PE'
  WHEN state = 'Piauí'              THEN 'PI'
  WHEN state = 'Rio de Janeiro'      THEN 'RJ'
  WHEN state = 'Rio Grande do Norte' THEN 'RN'
  WHEN state = 'Rio Grande do Sul'   THEN 'RS'
  WHEN state = 'Rondônia'           THEN 'RO'
  WHEN state = 'Roraima'             THEN 'RR'
  WHEN state = 'Santa Catarina'      THEN 'SC'
  WHEN state = 'São Paulo'          THEN 'SP'
  WHEN state = 'Sergipe'             THEN 'SE'
  WHEN state = 'Tocantins'           THEN 'TO'
  ELSE state
END
WHERE length(state) > 2;
