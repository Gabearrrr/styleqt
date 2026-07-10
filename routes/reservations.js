const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all reservations
router.get('/', (req, res) => {
    db.all(`SELECT r.*, c.Name as CustomerName, c.CustomerID, s.ServiceName, st.Name as StaffName 
            FROM Reservations r 
            JOIN Customers c ON r.CustomerID = c.CustomerID 
            JOIN Services s ON r.ServiceID = s.ServiceID 
            JOIN Staff st ON r.StaffID = st.StaffID`, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Get single reservation
router.get('/:id', (req, res) => {
    db.get(`SELECT r.*, c.Name as CustomerName, s.ServiceName, st.Name as StaffName 
            FROM Reservations r 
            JOIN Customers c ON r.CustomerID = c.CustomerID 
            JOIN Services s ON r.ServiceID = s.ServiceID 
            JOIN Staff st ON r.StaffID = st.StaffID 
            WHERE r.ReservationID = ?`, [req.params.id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Reservation not found' });
            return;
        }
        res.json(row);
    });
});

// Create reservation
router.post('/', (req, res) => {
    const { CustomerID, ServiceID, StaffID, ScheduleDate, ScheduleTime } = req.body;
    
    // First, get the service duration
    db.get('SELECT Duration FROM Services WHERE ServiceID = ?', [ServiceID], (err, service) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!service) {
            res.status(404).json({ error: 'Service not found' });
            return;
        }
        
        const duration = service.Duration; // Duration in minutes
        
        // Convert requested time to minutes for comparison
        const [reqHours, reqMinutes] = ScheduleTime.split(':').map(Number);
        const reqTimeInMinutes = reqHours * 60 + reqMinutes;
        const reqEndTimeInMinutes = reqTimeInMinutes + duration;
        
        // Check for conflicts with existing reservations
        // A conflict exists if:
        // - Existing reservation starts during the requested time slot
        // - OR existing reservation ends during the requested time slot
        // - OR existing reservation completely overlaps the requested time slot
        db.all(`SELECT r.*, s.Duration as ServiceDuration 
                FROM Reservations r 
                JOIN Services s ON r.ServiceID = s.ServiceID 
                WHERE r.StaffID = ? AND r.ScheduleDate = ? AND r.Status != 'cancelled'`,
            [StaffID, ScheduleDate],
            (err, existingReservations) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                for (const existing of existingReservations) {
                    const [existHours, existMinutes] = existing.ScheduleTime.split(':').map(Number);
                    const existTimeInMinutes = existHours * 60 + existMinutes;
                    const existEndTimeInMinutes = existTimeInMinutes + existing.ServiceDuration;
                    
                    // Check for overlap
                    if (reqTimeInMinutes < existEndTimeInMinutes && reqEndTimeInMinutes > existTimeInMinutes) {
                        const existEndTime = formatTime(existEndTimeInMinutes);
                        res.status(409).json({ 
                            error: `Staff is busy from ${existing.ScheduleTime} to ${existEndTime}. Please choose a different time or staff.` 
                        });
                        return;
                    }
                }
                
                // Create reservation if no conflict
                db.run('INSERT INTO Reservations (CustomerID, ServiceID, StaffID, ScheduleDate, ScheduleTime) VALUES (?, ?, ?, ?, ?)',
                    [CustomerID, ServiceID, StaffID, ScheduleDate, ScheduleTime],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }
                        res.json({ ReservationID: this.lastID, CustomerID, ServiceID, StaffID, ScheduleDate, ScheduleTime, Status: 'scheduled' });
                    }
                );
            }
        );
    });
});

// Helper function to format minutes back to HH:MM format
function formatTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

// Update reservation (admin only)
router.put('/:id', (req, res) => {
    const { Status, StaffID, ScheduleDate, ScheduleTime } = req.body;
    
    // If updating time or staff, check for conflicts
    if (ScheduleDate && ScheduleTime && StaffID) {
        // Get the service duration for this reservation
        db.get(`SELECT r.ServiceID, s.Duration 
                FROM Reservations r 
                JOIN Services s ON r.ServiceID = s.ServiceID 
                WHERE r.ReservationID = ?`,
            [req.params.id],
            (err, reservation) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                if (!reservation) {
                    res.status(404).json({ error: 'Reservation not found' });
                    return;
                }
                
                const duration = reservation.Duration;
                const [reqHours, reqMinutes] = ScheduleTime.split(':').map(Number);
                const reqTimeInMinutes = reqHours * 60 + reqMinutes;
                const reqEndTimeInMinutes = reqTimeInMinutes + duration;
                
                // Check for conflicts with other reservations (excluding this one)
                db.all(`SELECT r.*, s.Duration as ServiceDuration 
                        FROM Reservations r 
                        JOIN Services s ON r.ServiceID = s.ServiceID 
                        WHERE r.StaffID = ? AND r.ScheduleDate = ? AND r.Status != 'cancelled' AND r.ReservationID != ?`,
                    [StaffID, ScheduleDate, req.params.id],
                    (err, existingReservations) => {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }
                        
                        for (const existing of existingReservations) {
                            const [existHours, existMinutes] = existing.ScheduleTime.split(':').map(Number);
                            const existTimeInMinutes = existHours * 60 + existMinutes;
                            const existEndTimeInMinutes = existTimeInMinutes + existing.ServiceDuration;
                            
                            // Check for overlap
                            if (reqTimeInMinutes < existEndTimeInMinutes && reqEndTimeInMinutes > existTimeInMinutes) {
                                const existEndTime = formatTime(existEndTimeInMinutes);
                                res.status(409).json({ 
                                    error: `Staff is busy from ${existing.ScheduleTime} to ${existEndTime}. Please choose a different time or staff.` 
                                });
                                return;
                            }
                        }
                        
                        // No conflicts, proceed with update
                        performUpdate();
                    }
                );
            }
        );
    } else {
        performUpdate();
    }
    
    function performUpdate() {
        const updateFields = [];
        const updateValues = [];
        
        if (Status !== undefined) {
            updateFields.push('Status = ?');
            updateValues.push(Status);
        }
        if (StaffID !== undefined) {
            updateFields.push('StaffID = ?');
            updateValues.push(StaffID);
        }
        if (ScheduleDate !== undefined) {
            updateFields.push('ScheduleDate = ?');
            updateValues.push(ScheduleDate);
        }
        if (ScheduleTime !== undefined) {
            updateFields.push('ScheduleTime = ?');
            updateValues.push(ScheduleTime);
        }
        
        if (updateFields.length === 0) {
            res.status(400).json({ error: 'No fields to update' });
            return;
        }
        
        updateValues.push(req.params.id);
        
        db.run(`UPDATE Reservations SET ${updateFields.join(', ')} WHERE ReservationID = ?`,
            updateValues,
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                res.json({ message: 'Reservation updated' });
            }
        );
    }
});

// Delete reservation (admin only)
router.delete('/:id', (req, res) => {
    db.run('DELETE FROM Reservations WHERE ReservationID = ?', [req.params.id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Reservation deleted' });
    });
});

module.exports = router;
