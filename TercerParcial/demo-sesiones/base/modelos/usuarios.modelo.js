// Consultas a la tabla usuarios. Siempre con ? (consulta parametrizada), nunca pegando texto en el SQL.
const bcrypt = require('bcryptjs');

function crearModeloUsuarios(pool) {
  // Regresa el usuario (sin el hash) si la contraseña es correcta, o null si no.
  async function verificar(usuario, contrasena) {
    // Si falta algo, no hay nada que comparar.
    if (typeof usuario !== 'string' || typeof contrasena !== 'string') return null;

    // 1. Buscamos al usuario por su nombre. El ? evita inyección SQL.
    const [filas] = await pool.query(
      'SELECT id, usuario, nombre, rol, contrasena_hash FROM usuarios WHERE usuario = ?',
      [usuario]
    );
    if (filas.length === 0) return null; // no existe: no hay nada que comparar

    const { contrasena_hash, ...datos } = filas[0];

    // 2. bcrypt compara la contraseña escrita con el hash guardado.
    const coincide = await bcrypt.compare(contrasena, contrasena_hash);
    if (!coincide) return null;

    // 3. Regresamos los datos sin el hash.
    return datos;
  }

  return { verificar };
}

module.exports = { crearModeloUsuarios };