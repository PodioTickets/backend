/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: a "porta de entrada" dos dados de geografia (estados e cidades por país),
 *           usada no checkout para quem mora fora do Brasil.
 *
 *  EM RESUMO:
 *    Quando o site pede a lista de estados ou de cidades, este pedaço apenas recebe o
 *    pedido e repassa para quem realmente busca os dados — sem mudar nada no caminho.
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item é um teste aqui embaixo):
 *    • Pedir estados repassa o país correto e devolve a resposta como veio.
 *    • Pedir cidades repassa país, estado e o filtro de busca corretos.
 *    • Funciona mesmo sem filtro de busca.
 *
 *  COMO CONFERIMOS:
 *    Trocamos o "buscador de dados" por um de mentira e conferimos se o pedido chega nele
 *    com as informações certas. (A busca de verdade é testada no teste do buscador.)
 * ============================================================================
 */
import { Test, TestingModule } from '@nestjs/testing';
import { GeoController } from '../geo.controller';
import { GeoService } from '../geo.service';

describe('GeoController', () => {
  let controller: GeoController;
  let geoService: { getStates: jest.Mock; getCities: jest.Mock };

  beforeEach(async () => {
    geoService = { getStates: jest.fn(), getCities: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [GeoController],
      providers: [{ provide: GeoService, useValue: geoService }],
    }).compile();
    controller = moduleRef.get(GeoController);
  });

  it('pedir estados repassa o país e devolve a resposta recebida', () => {
    const payload = { success: true, data: { states: [{ code: 'CA', name: 'California' }] } };
    geoService.getStates.mockReturnValue(payload);

    const res = controller.getStates('US');

    expect(geoService.getStates).toHaveBeenCalledWith('US');
    expect(res).toBe(payload);
  });

  it('pedir cidades repassa país, estado e filtro de busca', () => {
    const payload = { success: true, data: { cities: [{ name: 'Los Angeles' }] } };
    geoService.getCities.mockReturnValue(payload);
    const query = { search: 'los', limit: 50 };

    const res = controller.getCities('US', 'CA', query as any);

    expect(geoService.getCities).toHaveBeenCalledWith('US', 'CA', query);
    expect(res).toBe(payload);
  });

  it('pedir cidades funciona mesmo sem filtro de busca', () => {
    geoService.getCities.mockReturnValue({ success: true, data: { cities: [] } });

    controller.getCities('PT', 'XYZ', {} as any);

    expect(geoService.getCities).toHaveBeenCalledWith('PT', 'XYZ', {});
  });
});
