# AGENTS.md

## Goal
Trabajar sobre este proyecto de forma segura sin romper la versión que ya está corriendo en un VPS.

## Context
- Existe una versión funcional en producción (VPS)
- Este entorno es LOCAL y se usará para pruebas
- No se debe afectar la estabilidad del sistema actual

## Rules
- NO rehacer la arquitectura existente
- NO hacer cambios destructivos
- NO modificar lógica crítica sin confirmación
- Explicar antes de hacer cambios grandes
- Mantener compatibilidad con el entorno actual
- Actualizar `README.md` si cambia la funcionalidad
- Actualizar `AGENTS.md` si cambian workflow o reglas
- Actualizar `CHANGELOG.md` después de cada tarea o conversación con:
  - qué se hizo
  - archivos modificados
  - comandos usados

## Workflow
1. Inspeccionar el proyecto
2. Detectar stack (lenguaje, framework, dependencias)
3. Identificar cómo se ejecuta actualmente
4. Replicar entorno local equivalente al VPS
5. Ejecutar primer build en local
6. Corregir solo errores mínimos necesarios
7. Reportar todo antes de continuar

## Safety
- Este entorno es solo para pruebas
- No asumir acceso al VPS
- No ejecutar comandos remotos
- No cambiar configuraciones sensibles sin aprobación
