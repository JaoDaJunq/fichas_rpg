# Fichas Daemon v4

Aplicação estática pronta para GitHub Pages, sem build.

## O que mudou nesta versão

Cada personagem agora possui duas visualizações usando os mesmos dados:

- **Modo de jogo:** ficha compacta para usar durante a sessão, inspirada na organização da ficha física do Trevas. Mostra atributos, perícias, combate, PV, reservas, aprimoramentos, magia, equipamentos, poderes, fraquezas e anotações sem campos de edição espalhados pela tela.
- **Editar ficha:** mantém o gerenciador completo para alterar atributos, identidade, perícias, combate, inventário, magia, aprimoramentos e demais dados.

No Modo de jogo:

- tocar em uma perícia rola 1d100;
- tocar em um atributo faz o teste pela regra da mesa;
- ataques que tenham uma porcentagem escrita no detalhe (ex.: `55% · 1d10+2`) ganham botão de rolagem;
- PV pode ser alterado rapidamente;
- PH e PM possuem controles rápidos;
- fichas antigas são atualizadas automaticamente com os novos campos de identidade.

## Arquivos

- `index.html`
- `styles.css`
- `app.js`

## Publicar no GitHub Pages

1. Substitua os três arquivos da versão anterior pelos arquivos desta pasta.
2. Faça commit/push para a branch publicada no GitHub Pages.
3. Recarregue o site. Se o navegador insistir em usar arquivos antigos, use `Ctrl + F5`.

A chave de armazenamento continua a mesma da versão anterior, então as mesas e fichas já criadas no navegador continuam disponíveis.

## Limitação atual

Os dados continuam em `localStorage`. Abas do mesmo navegador sincronizam entre si, mas dispositivos diferentes ainda precisam de um banco online para compartilhar a mesma mesa em tempo real.


## v6 - criação pelo livro

- Catálogo de Perícias por grupos e subgrupos do Sistema Daemon/Trevas.
- Valor-base de cada Perícia usa o Atributo correspondente ou 0% nas técnicas.
- Idioma Nativo começa em 30%.
- Perícia nova exige investimento mínimo de 10 pontos e permite até 50 pontos acima da base na criação.
- Botão opcional calcula o orçamento inicial de Perícias por INT x 5 + Idade x 10, limitado a 500.
- Catálogo de Aprimoramentos positivos e negativos integrado à ficha.
