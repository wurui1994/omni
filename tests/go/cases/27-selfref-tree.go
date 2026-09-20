package main

type Node struct {
	V     int
	Left  *Node
	Right *Node
}

func sum(n *Node) int {
	if n == nil {
		return 0
	}
	return n.V + sum(n.Left) + sum(n.Right)
}

func main() {
	var root *Node
	println(sum(root))
	root = &Node{V: 1, Left: &Node{V: 2}, Right: &Node{V: 3, Left: &Node{V: 4}}}
	println(sum(root))
	println(root.Left.V)
	println(root.Right.Left.V)
	if root.Left.Left == nil {
		println("leaf")
	}
}
