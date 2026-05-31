FORMULA E VALORES PARA QUANDO HOUVER UM ESTORNO E PRECISAR DESCOBRIR QUANDO O ORGANIZADOR VAI DEVER.

Se houve cupom e se esse cupom tem efeito para produtos adicionais do ingresso:


TAXA-CLIENTE-VOLATIL = TAXA-CLIENTE-FIXO * SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD  
TAXA-CLIENTE-FIXO = 0.02 (organizador vai alterar ao criar o evento)
TAXA-ORGANIZADOR-VOLATIL = TAXA-ORGANIZADOR-FIXO * SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD
TAXA-ORGANIZADOR-FIXO = 0.04 (organizador vai alterar ao criar o evento)
VALOR-DO-INGRESSO-FIXO = R$100,00 (organizador vai alterar ao criar o ingresso)
VALOR-DO-INGRESSO-VOLATIL = VALOR-DO-INGRESSO-FIXO - CUPOM
PRODUTO-ADICIONAL-FIXO = R$50,00 (organizador vai alterar ao criar o ingresso)
CUPOM = 50% (organizador vai alterar ao criar o ingress e pode ser valor em reais)

SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD = ((VALOR-DO-INGRESSO-FIXO + PRODUTO-ADICIONAL-FIXO) - cupom) 

VALOR-QUE-O-ORGANIZADOR-RECEBEU = VALOR TOTAL PAGO - TAXA CLIENTE VOLATIL - TAXA ORGANIZADOR VOLATIL

Fórmula para descobrir quando o organizador deve: VALOR-QUE-O-ORGANIZADOR-RECEBEU + (0.02 * SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD)


Se houve cupom e esse cupom NAO tem efeito para produtos adicionais do ingresso. 


TAXA-CLIENTE-VOLATIL = TAXA-CLIENTE-FIXO * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD 
TAXA-CLIENTE-FIXO = 0.02 (organizador vai alterar ao criar o evento)
TAXA-ORGANIZADOR-VOLATIL = TAXA-ORGANIZADOR-FIXO * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD
TAXA-ORGANIZADOR-FIXO = 0.04 (organizador vai alterar ao criar o evento)
VALOR-DO-INGRESSO-FIXO = R$100,00 (organizador vai alterar ao criar o ingresso)
VALOR-DO-INGRESSO-VOLATIL = VALOR-DO-INGRESSO-FIXO - CUPOM
PRODUTO-ADICIONAL-FIXO = R$50,00 (organizador vai alterar ao criar o ingresso)
CUPOM = 50% (organizador vai alterar ao criar o ingress e pode ser valor em reais)


SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD = ((VALOR-DO-INGRESSO-FIXO - cupom) + PRODUTO-ADICIONAL-FIXO)
VALOR-QUE-O-ORGANIZADOR-RECEBEU = VALOR-TOTAL-PAGO - TAXA-CLIENTE-VOLATIL - TAXA-ORGANIZADOR-VOLATIL


Fórmula para descobrir quando o organizador deve:
VALOR-QUE-O-ORGANIZADOR-RECEBEU + (0.02 * SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD)







HOUVE ESTORNO?

Primeira pergunta, qual o método de pagamento do pedido?

1- CARTAO PARCELADO
     
1.1  - Pegar VALOR-QUE-O-ORGANIZADOR-RECEBEU dividir pelo número de parcelas do pedido.
1.2  - Verifique quantas parcelas do pedido liberou e quantas não liberou. 
1.3  - Tire o valor somado das parcelas que liberou do saldo disponível.
1.4  - Tire o valor somado das parcelas que não liberou do parcelados a receber.
1.5 -  Verificar se o pedido utilizou cupom.
1.5.1- Se a resposta for SIM
      1.5.1.1- Verificar se o cupom considera produtos adicionais: 

      1.5.1.1.1 - Se a resposta for SIM

      Descontar (0.02 * SUBTOTALBACK-COM-CUPOM-PRODUTO-ADD) no saldo disponível. 

      1.5.1.1.1 - Se a resposta for NAO

      Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.

      1.5.1- Se a resposta for NÃO
      Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.


2- CARTAO A VISTA
2.1 - Verificar se passou de 31 dias. (se o valor se dividiu entre saldo disponível e aguardando liberação)

2.1.1 Se a resposta for NAO.

2.1.1.1 - Tirar 100% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do aguardando liberação.

E
Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.

2.1.2 Se a reposta for SIM





2.2 Verificar se o evento ainda está aguardando auditoria de retenção para liberar os 10%.

2.2.2 Se a resposta for NAO

2.2.2.1 - Tirar 100% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 
        
E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.

 2.2.1 - Se a resposta for SIM

2.2.1.1 Tirar 10% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do aguardando liberação. 
                E
Tirar 90% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 

E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível. 



3- PIX


3.1 - Verificar se o evento ainda está aguardando auditoria de retenção para liberar os 10%.

3.1.1 Se a resposta for NAO

3.1.1.1 - Tirar 100% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 
        
E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.

      3.2.1 - Se a resposta for SIM

         3.2.1.1 Tirar 10% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do aguardando liberação. 
                E
Tirar 90% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 

E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível. 



4- CARTAO DEBITO


4.1 - Verificar se o evento ainda está aguardando auditoria de retenção para liberar os 10%.

4.1.1 Se a resposta for NAO

4.1.1.1 - Tirar 100% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 
        
E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.

      4.2.1 - Se a resposta for SIM

         4.2.1.1 Tirar 10% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do aguardando liberação. 
                E
Tirar 90% do VALOR-QUE-O-ORGANIZADOR-RECEBEU do saldo disponível. 

E

Descontar (0.02 * SUBTOTALBACK-SEM-CUPOM-PRODUTO-ADD) no saldo disponível.








