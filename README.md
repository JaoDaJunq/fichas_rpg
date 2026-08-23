# Fichas Daemon

Aplicação estática feita para funcionar diretamente no GitHub Pages, sem build.

## Arquivos

- `index.html`
- `styles.css`
- `app.js`

## Publicar no GitHub Pages

1. Crie ou abra o repositório.
2. Envie estes três arquivos para a raiz.
3. Em **Settings > Pages**, selecione **Deploy from a branch**.
4. Use a branch `main` e a pasta `/root`.

## Importante sobre este protótipo

Os dados são salvos em `localStorage`, portanto ficam no navegador/dispositivo onde foram criados.

O fluxo Mestre/Jogador funciona integralmente no mesmo navegador. Para jogadores entrarem de celulares diferentes e o mestre ver as alterações em tempo real, será necessário conectar um banco online (por exemplo, Supabase ou Firebase). O código foi separado para essa evolução ser feita sem refazer a interface.
