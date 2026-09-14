const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { enforceTenantIsolation } = require('../middleware/tenantMiddleware');
const cryptoService = require('../services/cryptoService');
const crypto = require('crypto');
const { logAction } = require('../services/auditService');
const { v4: uuidv4 } = require('uuid');

router.use(requireAuth);
router.use(enforceTenantIsolation);

/**
 * GET /api/team
 * Returns list of team members within the authenticated organization.
 */
router.get('/', async (req, res) => {
  const orgId = req.organizationId;
  try {
    const usersRes = await db.query('SELECT * FROM users WHERE client_id = ?', [orgId]);
    const members = (usersRes.rows || []).map(u => ({
      id: u.id,
      fullName: u.full_name || u.email.split('@')[0],
      email: u.email,
      phoneNumber: u.phone_number,
      role: (u.role || 'VIEWER').toUpperCase(),
      status: (u.status || 'ACTIVE').toUpperCase(),
      authProvider: u.auth_provider || 'local',
      createdAt: u.created_at,
      updatedAt: u.updated_at
    }));

    res.json({
      success: true,
      totalMembers: members.length,
      members
    });
  } catch (err) {
    console.error('Error fetching team members:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load team members' });
  }
});

/**
 * POST /api/team/invite
 * Invites / creates a new member in the organization.
 * Restrict: ADMIN only.
 */
router.post('/invite', requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const { fullName, email, role, password } = req.body;

  if (!fullName || !email) {
    return res.status(400).json({ success: false, message: 'Full name and email are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const validRole = ['ADMIN', 'MANAGER', 'VIEWER'].includes((role || '').toUpperCase())
    ? role.toUpperCase()
    : 'VIEWER';

const subscriptionService = require('../services/subscriptionService');

  try {
    const existing = await db.getOne('SELECT * FROM users WHERE email = ?', [cleanEmail]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'A user with this email address already exists.' });
    }

    // Enforce SaaS Plan Seat Limit
    const usersRes = await db.query('SELECT * FROM users WHERE client_id = ? AND status = ?', [orgId, 'ACTIVE']);
    const currentMemberCount = (usersRes.rows || []).length;
    const maxSeats = await subscriptionService.getLimit(orgId, 'max_users');

    if (currentMemberCount >= maxSeats) {
      return res.status(403).json({
        success: false,
        code: 'SEAT_LIMIT_REACHED',
        error: 'SEAT_LIMIT_REACHED',
        message: `Your current plan allows up to ${maxSeats} user${maxSeats === 1 ? '' : 's'}. Upgrade your plan to add more users (seat limit reached).`,
        currentCount: currentMemberCount,
        maxSeats
      });
    }

    const userId = `user-${uuidv4().substring(0, 8)}`;
    // Generate a cryptographically random temporary password if none supplied by the admin.
    // The inviting admin is responsible for communicating this to the new team member securely.
    const tempPassword = password || crypto.randomBytes(12).toString('base64url');
    const passwordHash = cryptoService.hashPassword(tempPassword);

    await db.query(
      `INSERT INTO users (id, client_id, full_name, email, phone_number, password_hash, role, platform_role, status, auth_provider, onboarding_status)
       VALUES (?, ?, ?, ?, null, ?, ?, 'USER', 'ACTIVE', 'local', 'completed')`,
      [userId, orgId, fullName.trim(), cleanEmail, passwordHash, validRole]
    );

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'INVITE_TEAM_MEMBER',
      resource: 'team',
      details: { invitedEmail: cleanEmail, assignedRole: validRole }
    });

    res.json({
      success: true,
      message: `✓ Invitation created for ${cleanEmail} (${validRole})`,
      member: {
        id: userId,
        fullName: fullName.trim(),
        email: cleanEmail,
        role: validRole,
        status: 'ACTIVE',
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error inviting team member:', err.message);
    res.status(500).json({ success: false, message: 'Failed to invite team member' });
  }
});

/**
 * PUT /api/team/:userId
 * Updates user role or status (ACTIVE / DISABLED).
 * Restrict: ADMIN only.
 */
router.put('/:userId', requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const targetUserId = req.params.userId;
  const { role, status } = req.body;

  // Prevent self-demotion or self-disabling
  if (req.user.id === targetUserId) {
    if (role && role.toUpperCase() !== 'ADMIN') {
      return res.status(400).json({ success: false, message: 'You cannot remove your own Admin privileges.' });
    }
    if (status && status.toUpperCase() === 'DISABLED') {
      return res.status(400).json({ success: false, message: 'You cannot disable your own account.' });
    }
  }

  try {
    const user = await db.getOne('SELECT * FROM users WHERE id = ? AND client_id = ?', [targetUserId, orgId]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found in your organization.' });
    }

    const newRole = role ? role.toUpperCase() : (user.role || 'VIEWER');
    const newStatus = status ? status.toUpperCase() : (user.status || 'ACTIVE');

    if (!['ADMIN', 'MANAGER', 'VIEWER'].includes(newRole)) {
      return res.status(400).json({ success: false, message: 'Invalid role. Must be ADMIN, MANAGER, or VIEWER.' });
    }
    if (!['ACTIVE', 'DISABLED'].includes(newStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be ACTIVE or DISABLED.' });
    }

    await db.query(
      'UPDATE users SET role = ?, status = ? WHERE id = ? AND client_id = ?',
      [newRole, newStatus, targetUserId, orgId]
    );

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'UPDATE_USER_ROLE_OR_STATUS',
      resource: 'team',
      details: { targetUserId, newRole, newStatus }
    });

    res.json({
      success: true,
      message: '✓ Team member updated successfully',
      member: {
        id: targetUserId,
        fullName: user.full_name,
        email: user.email,
        role: newRole,
        status: newStatus
      }
    });
  } catch (err) {
    console.error('Error updating team member:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update team member' });
  }
});

/**
 * DELETE /api/team/:userId
 * Removes a member from the organization.
 * Restrict: ADMIN only.
 */
router.delete('/:userId', requireAdmin, async (req, res) => {
  const orgId = req.organizationId;
  const targetUserId = req.params.userId;

  // Prevent self-deletion
  if (req.user.id === targetUserId) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  }

  try {
    const user = await db.getOne('SELECT * FROM users WHERE id = ? AND client_id = ?', [targetUserId, orgId]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found in your organization.' });
    }

    await db.query('DELETE FROM users WHERE id = ? AND client_id = ?', [targetUserId, orgId]);

    await logAction({
      organizationId: orgId,
      userId: req.user.id,
      action: 'REMOVE_TEAM_MEMBER',
      resource: 'team',
      details: { removedUserId: targetUserId, removedEmail: user.email }
    });

    res.json({
      success: true,
      message: `✓ Member ${user.email} removed from organization`
    });
  } catch (err) {
    console.error('Error deleting team member:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove team member' });
  }
});

module.exports = router;
