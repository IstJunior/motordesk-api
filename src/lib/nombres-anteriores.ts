// Nombres de tablas y columnas antes de la migración 20261123000000_tablas_en_ingles
// del monolito, que los pasó del español al inglés.
//
// Existe para una sola cosa: que un respaldo de taller hecho ANTES de esa
// migración se pueda restaurar DESPUÉS. El respaldo guarda cada bloque con el
// nombre de la tabla y cada fila con sus columnas tal como eran; sin traducirlos,
// la restauración borraría las filas de las tablas renombradas y no reinsertaría
// nada (no encuentra el bloque por su nombre nuevo), y las columnas renombradas
// llegarían vacías.
//
// Es una lista cerrada: los respaldos nuevos ya traen los nombres nuevos y no
// pasan por aquí. No agregar nada salvo que otra migración vuelva a renombrar.

export const TABLAS_ANTERIORES: Record<string, string> = {
  fe_bolsas: "einvoice_pools",
  fe_paquetes: "einvoice_packages",
  consentimientos: "consents",
  contratos_firmados: "signed_contracts",
  codigos_firma: "signature_codes",
  puentes_superadmin: "superadmin_bridges",
  club_registros: "club_registrations",
  tecnico_porcentajes: "technician_rates",
  tecnico_comisiones: "technician_commissions",
  tecnico_pagos: "technician_payouts",
  ventas_en_espera: "held_sales",
};

// Por nombre NUEVO de la tabla: columna anterior -> columna actual.
export const COLUMNAS_ANTERIORES: Record<string, Record<string, string>> = {
  chat_message_media: { nombre: "name", tamano: "size" },
  chat_sessions: { canal: "channel" },
  club_registrations: { nombre: "name", telefono: "phone", rol: "role", marcas: "brands", ciudad: "city", origen: "source", ficha: "spec_sheet", estado: "status", envios: "submissions", creado_en: "created_at", actualizado_en: "updated_at", contactado_en: "contacted_at" },
  signature_codes: { correo: "email", codigo_hash: "code_hash", intentos: "attempts", creado_en: "created_at", expira_en: "expires_at", verificado_en: "verified_at", ip_verificacion: "verification_ip", usado_en: "used_at" },
  consents: { titular: "holder", documento: "document", canal: "channel", aceptado_en: "accepted_at", revocado_en: "revoked_at" },
  signed_contracts: { codigo: "code", canal: "channel", correo: "email", firmante_nombre: "signer_name", firmante_doc_tipo: "signer_doc_type", firmante_doc_numero: "signer_doc_number", taller_nombre: "workshop_name", taller_nit: "workshop_nit", contenido: "content", contenido_hash: "content_hash", evidencia: "evidence", firmado_en: "signed_at", copia_enviada_en: "copy_sent_at", firma_imagen: "signature_image", firma_imagen_hash: "signature_image_hash", firma_origen: "signature_source" },
  einvoice_pools: { proveedor: "provider", nombre: "name", documentos: "documents", precio: "price", comprada_el: "purchased_on", vence_el: "expires_on", notas: "notes" },
  einvoice_packages: { nivel: "tier", documentos: "documents", precio: "price", pagado_el: "paid_on", activable_desde: "activatable_from", activado_el: "activated_at", vence_el: "expires_at", anulado_el: "voided_at", notas: "notes", referencia: "reference" },
  inventory_items: { contenido_envase: "container_size" },
  superadmin_bridges: { destino: "destination", expira_en: "expires_at", usado_en: "used_at", creado_en: "created_at" },
  technician_commissions: { tipo: "type", porcentaje: "percentage", monto: "amount", pago_id: "payout_id" },
  technician_payouts: { monto: "amount", origen: "source", nota: "note" },
  technician_rates: { porcentaje: "percentage" },
  held_sales: { etiqueta: "label", contenido: "content" },
  workshop_dian_configs: { cupo_modalidad: "quota_mode", cupo_bolsa_id: "quota_pool_id" },
  workshops: { contrato_requerido: "contract_required" },
};

/** El nombre actual de una tabla que pudo venir con el anterior. */
export function tablaActual(tabla: string): string {
  return TABLAS_ANTERIORES[tabla] ?? tabla;
}

/**
 * Expresión SQL que convierte una fila JSON (`f`) con columnas anteriores en una
 * con las actuales. Solo renombra la llave si la fila la trae: una fila de un
 * respaldo nuevo pasa intacta. Los nombres salen de la lista cerrada de arriba,
 * nunca del respaldo, así que no hay nada que escapar.
 */
export function filaConColumnasActuales(tabla: string, f = "f"): string {
  const cols = COLUMNAS_ANTERIORES[tabla];
  if (!cols) return f;
  return Object.entries(cols).reduce(
    (expr, [anterior, actual]) =>
      `(CASE WHEN ${f} ? '${anterior}' THEN (${expr}) - '${anterior}' || jsonb_build_object('${actual}', ${f} -> '${anterior}') ELSE ${expr} END)`,
    f,
  );
}
