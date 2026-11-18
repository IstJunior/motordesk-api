// Embudo de venta: qué talleres en prueba tienen más probabilidad de comprar.
// El cálculo y por qué es un puntaje y no un modelo: lib/prediccion-compra.ts.

import { Hono } from "hono";
import { superadminGuard } from "../auth/middleware.js";
import { prediccionDeCompra } from "../lib/prediccion-compra.js";

export const embudoRoutes = new Hono<{ Variables: { superadmin: string } }>();
embudoRoutes.use("*", superadminGuard);

// GET /embudo — candidatos ordenados por puntaje, la referencia de los que
// compraron y los que se fueron sin comprar.
embudoRoutes.get("/", async (c) => c.json(await prediccionDeCompra()));
