import socket
import unittest
from port_preflight import check_ports


class Ports(unittest.TestCase):
    def test_active_listener_is_rejected(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0)); listener.listen()
            with self.assertRaises(OSError):
                check_ports([listener.getsockname()[1]])

    def test_just_closed_tcp_session_can_be_reused(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0)); listener.listen()
            port = listener.getsockname()[1]
            with socket.create_connection(('127.0.0.1', port)) as client:
                session, _ = listener.accept()
                session.shutdown(socket.SHUT_WR); session.close()
                self.assertEqual(client.recv(1), b'')
        check_ports([port])


if __name__ == '__main__':
    unittest.main()
