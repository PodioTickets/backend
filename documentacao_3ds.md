3DS

Para teste em sandbox, use:
Endpoint: https://mpisandbox.braspag.com.br
ClientId: dba3a8db-fa54-40e0-8bab-7bfb9b6f2e2e
ClientSecret: D/ilRsfoqHlSUChwAMnlyKdDNd7FMsM7cU/vo02REag=
É necessário realizar a requisição para criação do token

Endpoint: https://mpisandbox.braspag.com.br/v2/auth/token
Etapas importantes:
 
1. Criando o token de acesso
Em homologação

{
"EstablishmentCode": 1006993069,
"MerchantName": Loja Exemplo Ltda,
"MCC": 5912
}

Em produção esses dados serão diferentes
Importação: Um access token sera gerado.

2. Mapeando as classes

Nessa etapa é importante que considerem e incluam todos os campos indicados como obrigatórios.

3. Implementando o script

Após a execução do script, precisamos do retorno de sucesso abaixo:

{
Cavv: 'Y2FyZGluYWxjb21tZXJjZWF1dGg=',
Xid: null, Eci: '01',
Version: '2.2.0',
ReferenceId: '973cf83d-b378-43d5-84b6-ce1531475f2a'
}

Quando obtiverem esse retorno, preciso que informem o ReferenceId com data de horário.

 

4. Implementando chamada ao evento de autenticação

 

5. Etapa transacional do 3DS

Para concluir, após a consolidação de todos os dados para transação com 3DS, é necessário que façam um teste incluindo principalmente os campos destacados em vermelho na transação.

{
  "MerchantOrderId": "2017051001",
  "Customer": {
    "Name": "Aline de Souza",
    "Identity": "12345678909",
    "IdentityType": "CPF",
    "Email": "aline@email.com",
    "Birthdate": "1990-01-01",
    "IpAddress": "127.0.0.1"
  },
  "Payment": {
    "Provider": "Simulado",
    "Type": "CreditCard",
    "Amount": 10000,
    "Currency": "BRL",
    "Country": "BRA",
    "Installments": 1,
    "Interest": "ByMerchant",
    "Capture": true,
    "Authenticate": true,
    "Recurrent": false,
    "SoftDescriptor": "LojaTeste",
    "DoSplit": false,
    "Tip": false,
    "CreditCard": {
      "CardNumber": "4091688625337641",
      "Holder": "Aline de Souza",
      "ExpirationDate": "12/2035",
      "SecurityCode": "333",
      "Brand": "Visa",
      "SaveCard": false,
      "Alias": ""
    },
    "ExternalAuthentication": {
      "Cavv": "AAABB2gHA1B5EFNjWQcDAAAAAAB=",
      "Xid": "Uk5ZanBHcWw2RjRCbEN5dGtiMTB=",
      "Eci": "5",
      "Version": "2.2.0",
      "ReferenceID": "a24a5d87-b1a1-4aef-a37b-2f30b91274e6"
    },
    "Credentials": {
      "Code": "9999999",
      "Key": "D8888888",
      "Password": "LOJA9999999",
      "Username": "#Braspag2018@NOMEDALOJA#",
      "Signature": "001"
    },
    "ExtraDataCollection": [
      {
        "Name": "NomeDoCampo",
        "Value": "ValorDoCampo"
      }

 